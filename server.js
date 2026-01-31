const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
// 生产环境心跳：防止 Railway 等网关因长时间无数据而断开 WebSocket（可通过 PING_INTERVAL/PING_TIMEOUT 覆盖）
const PING_INTERVAL = parseInt(process.env.PING_INTERVAL, 10) || 10000;
const PING_TIMEOUT = parseInt(process.env.PING_TIMEOUT, 10) || 30000;
const io = new Server(server, {
    pingTimeout: PING_TIMEOUT,
    pingInterval: PING_INTERVAL
});

// 1. 基础框架：使用 Express 托管当前目录下的静态文件
app.use(express.static(__dirname));

// --- 游戏常量 (从客户端代码移植) ---
const SUITS = ['万', '筒', '条'];
const NUMBERS = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
const WINDS = ['东', '南', '西', '北'];
const DRAGONS = ['中', '发财', '白板'];

// 简化的海克斯数据 (仅用于生成选项，完整描述可由客户端渲染或服务端下发)
// 为了确保一致性，服务端只保留 ID，具体描述和 tier 由前端根据 ID 查找
const HEXTECH_IDS = [
    'silver_1', 'silver_3', 'silver_4', 'silver_6',
    'silver_new_1', 'silver_new_2', 'silver_new_3', 'silver_new_4',
    'silver_new_5', 'silver_new_6', 'silver_new_7', 'silver_new_8',
    'silver_new_9', 'silver_new_10', 'silver_new_11', 'silver_new_12',
    'gold_1', 'gold_2', 'gold_5', 'gold_6', 'gold_7', 'gold_8', 'gold_10',
    'gold_new_1', 'gold_new_2', 'gold_new_3', 'gold_new_4', 'gold_new_5',
    'gold_new_6', 'gold_new_7', 'gold_new_8', 'gold_new_9',
    'prism_3', 'prism_4', 'prism_6', 'prism_9',
    'prism_new_1', 'prism_new_2', 'prism_new_3', 'prism_new_4', 'prism_new_5',
    'prism_new_6', 'prism_new_7', 'prism_new_8', 'prism_new_9', 'prism_new_10',
    'prism_new_11', 'prism_new_12', 'prism_new_13', // 棱彩命运：选后随机替换为其它彩色
    'prism_new_14', 'prism_new_15', 'prism_new_16'   // 天命眷顾、大魔法师、代码干扰
];
// 棱彩命运 ID，选到时从 PRISMATIC_OTHER 中随机一个替换，避免套娃
const PRISM_FATE_ID = 'prism_new_13';
const PRISMATIC_OTHER = HEXTECH_IDS.filter(id => id.startsWith('prism') && id !== PRISM_FATE_ID);

const HEX_TIERS = ['silver', 'gold', 'prismatic'];
const HEXTECH_POOLS = {
    silver: HEXTECH_IDS.filter(id => id.startsWith('silver')),
    gold: HEXTECH_IDS.filter(id => id.startsWith('gold')),
    prismatic: HEXTECH_IDS.filter(id => id.startsWith('prism'))
};

// --- 房间系统 ---
const rooms = {};
// 供 startNextRound 调用的广播/计时器/出牌引用（在 io.on('connection') 内赋值）
let _broadcastGameState = null;
let _startTurnTimer = null;
let _handleDiscard = null;

// 生成唯一玩家身份 ID（用于断线重连）
function generatePlayerId() {
    return 'pid_' + Date.now() + '_' + Math.random().toString(36).slice(2, 11);
}

// 辅助函数：创建一副麻将牌
function createDeck() {
    let deck = [];
    // 序数牌 (108张)
    for (let suit of SUITS) {
        for (let num of NUMBERS) {
            for (let i = 0; i < 4; i++) {
                deck.push(num + suit);
            }
        }
    }
    // 字牌 (28张)
    for (let wind of WINDS) {
        for (let i = 0; i < 4; i++) {
            deck.push(wind);
        }
    }
    for (let dragon of DRAGONS) {
        for (let i = 0; i < 4; i++) {
            deck.push(dragon);
        }
    }
    return deck;
}

// 辅助函数：洗牌 (Fisher-Yates)
function shuffle(deck) {
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

// 辅助函数：随机选择一个海克斯等级（银/金/彩），三个等级概率相同
function getRandomHexTier() {
    const idx = Math.floor(Math.random() * HEX_TIERS.length);
    return HEX_TIERS[idx];
}

// 第一个海克斯必为彩色；第二、三个海克斯随机
function getHexTierForRound(roundNum) {
    if (roundNum === 1) return 'prismatic';
    return getRandomHexTier();
}

// 辅助函数：在指定等级中随机生成 3 个海克斯选项，排除该玩家已选的同等级海克斯
function generateHextechOptionsForTier(tier, excludeIds = []) {
    const fullPool = HEXTECH_POOLS[tier] || [];
    const pool = fullPool.filter(id => !excludeIds.includes(id));
    const options = [];
    for (let i = 0; i < 3; i++) {
        if (pool.length === 0) break;
        const randomIndex = Math.floor(Math.random() * pool.length);
        options.push(pool[randomIndex]);
        pool.splice(randomIndex, 1);
    }
    return options;
}

// --- 核心算法 (从客户端移植) ---

function getTileWeight(tile) {
    if (!tile) return 999;
    const suitsOrder = {'万': 0, '筒': 1, '条': 2};
    const numbersOrder = {'一':1, '二':2, '三':3, '四':4, '五':5, '六':6, '七':7, '八':8, '九':9};
    const windsOrder = {'东':0, '南':1, '西':2, '北':3};
    const dragonsOrder = {'中':0, '发财':1, '白板':2};

    const suit = tile.slice(-1);
    const num = tile.slice(0, -1);
    if (suitsOrder[suit] !== undefined) {
        return suitsOrder[suit] * 100 + (numbersOrder[num] || 0);
    }

    if (windsOrder[tile] !== undefined) {
        return 300 + windsOrder[tile];
    }
    if (dragonsOrder[tile] !== undefined) {
        return 350 + dragonsOrder[tile];
    }
    
    return 999;
}

function sortHand(hand) {
    if (!hand) return;
    hand.sort((a, b) => getTileWeight(a) - getTileWeight(b));
}

function removeOne(arr, item) {
    const idx = arr.indexOf(item);
    if (idx > -1) arr.splice(idx, 1);
}

// 天命眷顾：每局前三巡摸牌必为手中已有牌
function drawTileFromDeck(room, player) {
    const deck = room.state.deck;
    if (!deck || deck.length === 0) return null;
    const drawCount = player.drawCountThisRound || 0;
    if (player.hextechs && player.hextechs.includes('prism_new_14') && drawCount < 3) {
        const handSet = new Set(player.hand);
        for (let i = 0; i < deck.length; i++) {
            if (handSet.has(deck[i])) {
                const tile = deck.splice(i, 1)[0];
                player.drawCountThisRound = drawCount + 1;
                return tile;
            }
        }
    }
    player.drawCountThisRound = (player.drawCountThisRound || 0) + 1;
    return deck.pop();
}

// 纯函数：仅用局部数组，无闭包长期引用，无内存泄漏
function checkWin(handTiles, pengs, gangs, wildcardTile = null, extraGhosts = 0) {
    let effectiveHand = [...handTiles];
    let ghostCount = extraGhosts;
    
    if (wildcardTile) {
        const count = effectiveHand.filter(t => t === wildcardTile).length;
        if (count > 0) {
            ghostCount += count;
            effectiveHand = effectiveHand.filter(t => t !== wildcardTile);
        }
    }

    if ((effectiveHand.length + ghostCount) % 3 !== 2) return false;
    sortHand(effectiveHand);

    const uniqueTiles = [...new Set(effectiveHand)];
    for (let pairTile of uniqueTiles) {
        const c = effectiveHand.filter(t => t === pairTile).length;
        const need = 2 - c;
        const actualNeed = Math.max(0, need);
        
        if (ghostCount >= actualNeed) {
            const remaining = [...effectiveHand];
            for(let k=0; k<Math.min(2, c); k++) removeOne(remaining, pairTile);
            if (canFormSetsWithGhost(remaining, ghostCount - actualNeed)) return true;
        }
    }
    
    if (ghostCount >= 2) {
         if (canFormSetsWithGhost(effectiveHand, ghostCount - 2)) return true;
    }

    return false;
}

function canFormSetsWithGhost(tiles, ghosts) {
    if (tiles.length === 0) {
        return ghosts % 3 === 0;
    }
    
    const first = tiles[0];
    const c = tiles.filter(t => t === first).length;
    const need = Math.max(0, 3 - c);
    
    if (ghosts >= need) {
        const newTiles = [...tiles];
        for(let k=0; k<Math.min(3, c); k++) removeOne(newTiles, first);
        if (canFormSetsWithGhost(newTiles, ghosts - need)) return true;
    }
    
    if (!WINDS.includes(first) && !DRAGONS.includes(first)) {
        const suit = first.slice(-1);
        const numChar = first.slice(0, -1);
        const numIndex = NUMBERS.indexOf(numChar);
        
        if (numIndex <= 6) {
            const second = NUMBERS[numIndex + 1] + suit;
            const third = NUMBERS[numIndex + 2] + suit;
            
            const hasSecond = tiles.includes(second);
            const hasThird = tiles.includes(third);
            
            let needSeq = 0;
            if (!hasSecond) needSeq++;
            if (!hasThird) needSeq++;
            
            if (ghosts >= needSeq) {
                const newTiles = [...tiles];
                removeOne(newTiles, first);
                if (hasSecond) removeOne(newTiles, second);
                if (hasThird) removeOne(newTiles, third);
                
                if (canFormSetsWithGhost(newTiles, ghosts - needSeq)) return true;
            }
        }
    }
    
    return false;
}

function getWinningTiles(hand13, wildcardTile = null) {
    const winningTiles = [];
    const allTiles = [];
    SUITS.forEach(s => NUMBERS.forEach(n => allTiles.push(n + s)));
    WINDS.forEach(w => allTiles.push(w));
    DRAGONS.forEach(d => allTiles.push(d));

    for (let t of allTiles) {
        if (checkWin([...hand13, t], [], [], wildcardTile)) {
            winningTiles.push(t);
        }
    }
    return winningTiles;
}

function getTingCandidates(hand, wildcardTile = null) {
    const candidates = {};
    for (let i = 0; i < hand.length; i++) {
        const tempHand = [...hand];
        tempHand.splice(i, 1);
        const winners = getWinningTiles(tempHand, wildcardTile);
        if (winners.length > 0) {
            candidates[i] = winners;
        }
    }
    return candidates;
}

// 听牌后自己回合可杠选项：暗杠、补杠（不含明杠）
function getGangOptionsForTingPlayer(player) {
    const options = [];
    const counts = {};
    player.hand.forEach(t => { counts[t] = (counts[t] || 0) + 1; });
    for (const tile of Object.keys(counts)) {
        if (counts[tile] >= 4) options.push({ type: 'an', tile });
    }
    player.peng.forEach(tile => {
        if (player.hand.indexOf(tile) !== -1) options.push({ type: 'added', tile });
    });
    return options;
}

// --- 裁判逻辑辅助函数 ---

function checkActionsAfterDiscard(room, discardedTile, discarderId) {
    const actions = {}; // { playerId: [ { type, data } ] }
    // 听牌时打出的那张牌，别人不可以碰、杠、胡
    if (room.state.lastDiscard && room.state.lastDiscard.isTingDiscard) {
        return actions;
    }
    const discarder = room.players.find(p => p.id === discarderId);
    
    // Prism New 8: 绝户计 (别人不能碰、不能杠)
    const canOthersInteract = !discarder.hextechs.includes('prism_new_8');

    room.players.forEach(player => {
        if (player.id === discarderId) return;

        const playerActions = [];

        // 1. 胡牌检测 (点炮)
        // Prism New 9: 铁壁 (只要没听牌，打出的牌别人不能胡)
        // 规则修正：只有听牌玩家才能胡牌
        const canHu = (!discarder.hextechs.includes('prism_new_9') || discarder.isTing) && player.isTing;
        if (canHu && checkWin([...player.hand, discardedTile], player.peng, player.gang, player.wildcardTile)) {
            playerActions.push({ type: 'hu', data: { tile: discardedTile } });
        }

        // 只有未听牌的玩家才能进行碰、明杠操作
        if (canOthersInteract && !player.isTing) {
            // 2. 碰牌检测
            const tileCount = player.hand.filter(t => t === discardedTile).length;
            if (tileCount >= 2) {
                playerActions.push({ type: 'peng', data: { tile: discardedTile } });
            }

            // 3. 杠牌检测 (明杠)
            if (tileCount === 3) {
                playerActions.push({ type: 'gang', data: { type: 'ming', tile: discardedTile } });
            }
        }

        if (playerActions.length > 0) {
            actions[player.id] = playerActions;
        }
    });

    return actions;
}

function calculateScoring(room, winType, winnerId, loserId) {
    const scoreChanges = { 0: 0, 1: 0, 2: 0, 3: 0 };
    const summary = [];
    
    // 0. 预处理 (海克斯前置检查)
    if (winType === 'dianpao') {
        const winner = room.players[winnerId];
        if (winner.hextechs.includes('prism_new_1')) {
            winType = 'zimo';
            summary.push(`【全民皆兵】${winner.name} 将点炮视为自摸！全场买单！`);
        }
    }

    // 庄家连庄判定
    if (winType !== 'liuju') {
        if (winnerId === room.state.dealerId) {
            room.state.dealerStreak = (room.state.dealerStreak || 0) + 1;
            summary.push(`庄家 ${room.players[winnerId].name} 胡牌，连庄中 (${room.state.dealerStreak}连)`);
        } else {
            room.state.dealerStreak = 0;
        }
    } else {
        room.state.dealerStreak = 0; // 流局通常不连庄，除非有特殊规则
    }

    // 1. 结算胡牌分
    if (winType !== 'liuju') {
        const winner = room.players[winnerId];
        const isWinnerDealer = (winnerId === room.state.dealerId);
        
        let extraWinScore = 0;
        let winMultiplier = 1;

        // 基础倍率：庄家胡牌/闲家胡庄家通常有加成
        let dealerMultiplier = isWinnerDealer ? 2 : 1;
        if (isWinnerDealer && winner.hextechs.includes('gold_new_1')) {
            dealerMultiplier = 3;
            summary.push("【庄家世家】庄家收益提升至 3 倍");
        }

        // --- 海克斯加成逻辑 ---
        
        // Gold New 6: 快节奏 (前 12 巡翻倍)
        if (winner.hextechs.includes('gold_new_6') && room.state.turnCount <= 12) {
            winMultiplier *= 2;
            summary.push("【快节奏】速攻，得分翻倍");
        }

        // Gold 2: 庄家威严 (庄家自摸闲家付6分)
        let isZhuangWeiYan = false;
        if (winner.hextechs.includes('gold_2') && isWinnerDealer && winType === 'zimo') {
            isZhuangWeiYan = true;
            summary.push("【庄家威严】庄家自摸，闲家需支付 6 分");
        }

        // Prism New 3: 终结者 (有杠翻倍)
        if (winner.hextechs.includes('prism_new_3') && winner.gang.length > 0) {
            winMultiplier *= 2;
            summary.push("【终结者】胡牌且有杠，得分×2");
        }

        // Prism New 5: 孤注一掷 (报听后胡牌×5)
        if (winner.hextechs.includes('prism_new_5') && winner.isTing) {
            winMultiplier *= 5;
            summary.push("【孤注一掷】得分×5");
        }

        // Prism New 6: 老当益壮 (第11局以后×5)
        if (winner.hextechs.includes('prism_new_6') && room.state.roundNum > 11) {
            winMultiplier *= 5;
            summary.push("【老当益壮】后期爆发，得分×5");
        }

        // Gold 6: 绝地翻盘 (总分最后一名时，自摸翻倍)
        const minS = Math.min(...room.players.map(p => p.score));
        if (winType === 'zimo' && winner.hextechs.includes('gold_6') && winner.score === minS) {
            winMultiplier *= 2;
            summary.push("【绝地翻盘】绝境反击，得分翻倍");
        }
 
         // 计算总分
         const baseScore = 2;
         let finalWinnerScore = (baseScore + extraWinScore) * winMultiplier * dealerMultiplier;

         // --- 额外支付计算 ---
         let extraPerPerson = 0;
         
         // Silver 4: 边张好手 (自摸胡3、7时，每家多付1分)
         if (winType === 'zimo' && winner.hextechs.includes('silver_4')) {
             const winTile = winner.hand[winner.hand.length-1];
             if (winTile && (winTile.startsWith('三') || winTile.startsWith('七'))) {
                 extraPerPerson += 1;
                 summary.push("【边张好手】胡 3/7，每家多付 1 分");
             }
         }

         // Silver New 8: 闲家之光 (作为闲家胡牌时，多收每家 1 分)
         if (winnerId !== room.state.dealerId && winner.hextechs.includes('silver_new_8')) {
             extraPerPerson += 1;
             summary.push("【闲家之光】闲家胡牌，每家多付 1 分");
         }

         if (winType === 'zimo') {
             room.players.forEach(p => {
                 if (p.id !== winnerId) {
                     let payment = finalWinnerScore;
                     
                     // Prism 6: 庄家杀手
                    if (winnerId !== room.state.dealerId && p.id === room.state.dealerId && winner.hextechs.includes('prism_6')) {
                        payment *= 3;
                    } else if (p.id === room.state.dealerId) {
                        // 庄家通常需支付双倍 (除非是庄家杀手覆盖)
                        payment *= 2;
                    }
                     
                     // Prism 4: 推倒之王 (未听牌翻倍)
                     if (winner.hextechs.includes('prism_4') && !p.isTing) {
                         payment *= 2;
                     }
                     
                     // Apply Extras
                     payment += extraPerPerson;

                     // Gold 2: 庄家威严 (Fixed 6 points, overrides others)
                     if (isZhuangWeiYan) payment = 6;

                     scoreChanges[p.id] -= payment;
                     scoreChanges[winnerId] += payment;
                 }
             });
         } else if (winType === 'dianpao') {
             const loser = room.players[loserId];
            let payment = finalWinnerScore;
            
            // 庄家点炮支付双倍
            if (loserId === room.state.dealerId) {
                payment *= 2;
            }

            // Prism 4: 推倒之王
             if (winner.hextechs.includes('prism_4') && !loser.isTing) {
                 payment *= 2;
             }
             
             // Apply Extras
             payment += extraPerPerson;
             
             // Gold 8: 精准打击 (Override)
             if (loser.hextechs.includes('gold_8') && winnerId === room.state.dealerId) {
                 payment = 1; 
                 summary.push("【精准打击】点炮给庄家仅支付 1 分");
             }
             
             // Silver New 1: 省钱专家
             if (loser.hextechs.includes('silver_new_1')) {
                 payment = Math.max(1, payment - 1);
             }

             scoreChanges[loserId] -= payment;
             scoreChanges[winnerId] += payment;

             // Gold 7: 杠后余生 (杠上炮免单)
             if (room.state.lastDiscard?.isGangDiscard && loser.hextechs.includes('gold_7')) {
                 scoreChanges[loserId] += payment; // Refund
                 // Winner keeps points (System Paid)
                 summary.push("【杠后余生】杠上炮免单，由系统支付");
             }
         }

         // --- 系统支付类海克斯 (System Paid) - 改为全员检查 ---
         
         room.players.forEach(p => {
             // Gold New 9: 资本家 (每10分+1，仅胡牌时加给胡牌者，点炮/未胡不加)
             if (p.id === winnerId && p.hextechs.includes('gold_new_9')) {
                 const capBonus = Math.floor(Math.max(0, p.score) / 10);
                 if (capBonus > 0) {
                     scoreChanges[p.id] += capBonus;
                     summary.push(`【资本家】${p.name} 获得资产分红 ${capBonus} 分`);
                 }
             }

             // Prism 3: 暗箭难防 (仅手牌暗刻：手牌三张相同算一暗杠，几刻子几暗杠；碰的明刻不算)
             if (p.id === winnerId && p.hextechs.includes('prism_3')) {
                 const counts = {};
                 p.hand.forEach(t => counts[t] = (counts[t] || 0) + 1);
                 // 仅暗刻：手牌中每种牌出现次数>=3 算一组刻子（碰出去的明刻不在 hand 中，不参与）
                 const triplets = Object.values(counts).filter(c => c >= 3).length;
                 if (triplets > 0) {
                     let scorePerTriplet = 6; // 每暗杠每人付 2，共 3 人
                     if (p.hextechs.includes('gold_1')) {
                         scorePerTriplet *= 2;
                     }
                     const paymentPerPerson = (scorePerTriplet * triplets) / 3;
                     room.players.forEach(other => {
                         if (other.id !== p.id) {
                             scoreChanges[other.id] -= paymentPerPerson;
                             scoreChanges[p.id] += paymentPerPerson;
                         }
                     });
                     summary.push(`【暗箭难防】${triplets} 组暗刻视为暗杠，收取每人 ${paymentPerPerson} 分`);
                 }
             }
             
             // Silver New 9: 稳扎稳打 (连续3局不点炮+4) - 修复 scoreChanges 同步问题
             // 注意：consecutiveNonDianpao 逻辑在下方循环中处理，这里仅处理结算同步
             // 为了避免双重计算，我们将下方的逻辑移到这里，或者在这里统一处理
         });

         // Gold New 7: 社交恐怖 (仅胡牌者：碰牌后胡牌才加分，每碰一次+2)
         if (winner.hextechs.includes('gold_new_7') && winner.peng.length > 0) {
             const pengBonus = winner.peng.length * 2;
             scoreChanges[winnerId] += pengBonus;
             summary.push(`【社交恐怖】${winner.name} 碰牌后胡牌，额外+${pengBonus} 分`);
         }

         // Silver new 2: 杠上添花 (仅胡牌者：本局有杠且胡牌才加分)
         if (winner.hextechs.includes('silver_new_2') && winner.gang.length > 0) {
             scoreChanges[winnerId] += 2;
             summary.push(`【杠上添花】${winner.name} 本局有杠且胡牌，额外+2 分`);
         }

         // Silver new 5: 早起鸟儿 (仅胡牌者，前 10 巡胡牌额外加 4 分)
         if (winner.hextechs.includes('silver_new_5') && room.state.turnCount <= 10) {
            scoreChanges[winnerId] += 4;
            summary.push("【早起鸟儿】系统额外支付 4 分");
         }

         // Silver new 6: 底力 (仅胡牌者，分数最低+5)
         const minScore = Math.min(...room.players.map(p => p.score));
         if (winner.hextechs.includes('silver_new_6') && winner.score === minScore) {
             scoreChanges[winnerId] += 5;
             summary.push("【底力】系统额外支付 5 分");
         }

         // Silver new 7: 收集癖 (仅胡牌者，2对刻子+2)
         if (winner.hextechs.includes('silver_new_7')) {
             let tripletCount = winner.peng.length + winner.gang.length;
             const counts = {};
             winner.hand.forEach(t => counts[t] = (counts[t]||0)+1);
             tripletCount += Object.values(counts).filter(c => c >= 3).length;
             if (tripletCount >= 2) {
                 scoreChanges[winnerId] += 2;
                 summary.push("【收集癖】系统额外支付 2 分");
             }
         }

         // Silver New 10: 环保卫士 (仅胡牌者，无风牌+2)
         if (winner.hextechs.includes('silver_new_10')) {
             const hasWinds = [...winner.hand, ...winner.peng, ...winner.gang].some(t => WINDS.includes(t));
             if (!hasWinds) {
                 scoreChanges[winnerId] += 2;
                 summary.push("【环保卫士】系统额外支付 2 分");
             }
         }

         // Silver New 11: 清仓处理 (仅胡牌者，手牌<=5张+3)
         if (winner.hextechs.includes('silver_new_11') && winner.hand.length <= 5) {
             scoreChanges[winnerId] += 3;
             summary.push("【清仓处理】系统额外支付 3 分");
         }

         // Gold 5: 连庄霸主 (连庄>=2胡牌+3)
         if (winner.hextechs.includes('gold_5') && room.state.dealerStreak >= 2) {
             scoreChanges[winnerId] += 3;
             summary.push("【连庄霸主】系统额外支付 3 分");
         }

         // Gold New 2: 风牌克星 (+5)
         if (winner.hextechs.includes('gold_new_2')) {
             const hasWinds = [...winner.hand, ...winner.peng, ...winner.gang].some(t => WINDS.includes(t));
             if (!hasWinds) {
                 scoreChanges[winnerId] += 5;
                 summary.push("【风牌克星】系统额外支付 5 分");
             }
         }

         // Gold New 3: 连胜风暴 (连胡两局后，本局加3分；consecutiveWins 在 handleRoundEnd 才+1，故此处用 >=1 表示本局胡后为第2连)
         if (winner.hextechs.includes('gold_new_3') && (winner.consecutiveWins || 0) >= 1) {
             scoreChanges[winnerId] += 3;
             summary.push("【连胜风暴】系统额外支付 3 分");
         }

         // Gold New 4: 死磕到底 (单钓 +5)
         if (winner.hextechs.includes('gold_new_4')) {
             const checkHand = [...winner.hand];
             const winTile = (winType === 'zimo') ? winner.hand[winner.hand.length - 1] : (room.state.lastDiscard && room.state.lastDiscard.tile);
             if (winTile) {
                 removeOne(checkHand, winTile);
                 const winningTiles = getWinningTiles(checkHand, winner.wildcardTile);
                 if (winningTiles.length === 1) {
                     scoreChanges[winnerId] += 5;
                     summary.push("【死磕到底】系统额外支付 5 分");
                 }
             }
         }

         // Prism New 7: 推倒一切 (全顺子+10)
         if (winner.hextechs.includes('prism_new_7')) {
             const counts = {};
             winner.hand.forEach(t => counts[t] = (counts[t]||0)+1);
             const hasTriplets = Object.values(counts).some(c => c >= 3) || winner.peng.length > 0 || winner.gang.length > 0;
             if (!hasTriplets) {
                 scoreChanges[winnerId] += 10;
                 summary.push("【推倒一切】系统额外支付 10 分");
             }
         }

         // Prism New 11: 底牌反击 (牌墙<10张+10)
         if (winner.hextechs.includes('prism_new_11') && room.state.deck.length < 10) {
             scoreChanges[winnerId] += 10;
             summary.push("【底牌反击】系统额外支付 10 分");
         }

         // Prism New 2: 杠上开花 (杠上开花+10)
         if (winner.hextechs.includes('prism_new_2') && winType === 'zimo' && winner.justGanged) {
             scoreChanges[winnerId] += 10;
             summary.push("【杠上开花】系统额外支付 10 分");
         }

         // Prism New 12: 不动如山 (门清+10)
         if (winner.hextechs.includes('prism_new_12') && winner.peng.length === 0 && winner.gang.length === 0) {
             scoreChanges[winnerId] += 10;
             summary.push("【不动如山】系统额外支付 10 分");
         }
         
         // Prism New 10: 轮回 (返还损失)
         if (winner.hextechs.includes('prism_new_10') && winner.reincarnationScore > 0) {
             const refund = winner.reincarnationScore;
             scoreChanges[winnerId] += refund;
             winner.reincarnationScore = 0;
             summary.push(`【轮回】系统返还上局损失 ${refund} 分`);
         }
         
         // 记录点炮损失供下局轮回使用
         if (winType === 'dianpao') {
             const loser = room.players[loserId];
             if (loser.hextechs.includes('prism_new_10')) {
                 loser.reincarnationScore = Math.abs(scoreChanges[loserId]);
             }
         }
    } else {
         summary.push("本局流局");

         // Gold 10: 刮风下雨 (流局时未听牌者额外赔2分)
         room.players.forEach(p => {
             if (p.hextechs.includes('gold_10')) {
                 room.players.forEach(other => {
                     if (other.id !== p.id && !other.isTing) {
                         scoreChanges[other.id] -= 2;
                         scoreChanges[p.id] += 2;
                         summary.push(`${other.name} 未听牌，补偿 ${p.name} 2分 (刮风下雨)`);
                     }
                 });
             }
         });

         // Silver new 3: 报听补贴 (报听后若流局，系统补偿 3 分)
         room.players.forEach(p => {
             if (p.hextechs.includes('silver_new_3') && p.isTing) {
                 scoreChanges[p.id] += 3;
                 summary.push(`${p.name} 触发【报听补贴】，系统补偿 3 分`);
             }
         });
     }

    // 应用积分变动 - 移除此处直接应用，统一由 handleRoundEnd 处理，防止双重计算
    // for (let pid in scoreChanges) {
    //     room.players[pid].score += scoreChanges[pid];
    // }

     // 稳扎稳打逻辑 (Silver New 9)
     room.players.forEach(p => {
         if (winType === 'dianpao' && p.id === loserId) {
             p.consecutiveNonDianpao = 0;
         } else {
             p.consecutiveNonDianpao = (p.consecutiveNonDianpao || 0) + 1;
             if (p.hextechs.includes('silver_new_9') && p.consecutiveNonDianpao % 3 === 0) {
                 // p.score += 4; // 移除直接修改，统一使用 scoreChanges
                 scoreChanges[p.id] += 4;
                 summary.push(`${p.name} 触发【稳扎稳打】，连续 3 局未点炮，获得 4 积分奖励！`);
             }
         }
     });

     return { scoreChanges, summary };
 }

function handleRoundEnd(roomName, winnerId, winType, loserId, scoreChanges, summary) {
    const room = rooms[roomName];
    if (!room) return;

    // 应用分数变化（确保按玩家 id 正确加减分）
    if (scoreChanges && typeof scoreChanges === 'object') {
        for (const [pid, change] of Object.entries(scoreChanges)) {
            const id = parseInt(pid, 10);
            if (Number.isNaN(id) || id < 0 || id > 3) continue;
            const player = room.players.find(p => p.id === id);
            if (player) {
                const delta = Number(change);
                if (!Number.isNaN(delta)) player.score += delta;
            }
        }
    }

    // 更新胜率和连胜逻辑
    room.players.forEach(p => {
        if (p.id === winnerId) {
            p.consecutiveWins = (p.consecutiveWins || 0) + 1;
        } else if (winType !== 'liuju') {
            p.consecutiveWins = 0;
        }
    });

    // 广播本局结束（带下一局局数，方便客户端立即显示“第 2/16 局”等）
    const nextRound = room.state.roundNum + 1;
    io.to(roomName).emit('roundEnd', {
        winnerId,
        winType,
        loserId,
        scoreChanges,
        summary,
        roundNum: room.state.roundNum,
        nextRoundNum: nextRound <= 16 ? nextRound : null,
        isGameOver: room.state.roundNum >= 16
    });

    // 广播胡牌语音
    if (winType !== 'liuju' && winnerId !== null) {
        io.to(roomName).emit('playerPerformedAction', {
            playerId: winnerId,
            type: 'hu'
        });
    }

    if (room.state.roundNum < 16) {
        if (room.timer) clearTimeout(room.timer);
        room.timer = null;
        if (room.actionTimer) clearTimeout(room.actionTimer);
        room.actionTimer = null;
        if (room.turnTimer) clearTimeout(room.turnTimer);
        room.turnTimer = null;
        if (room.archmageTimer) clearTimeout(room.archmageTimer);
        room.archmageTimer = null;
        room.waitingForArchmage = null;
        room.state.status = 'ended';
        room.state.roundNum++;
        // 延迟 8 秒后自动开始下一局 (给玩家时间看结算)
        setTimeout(() => {
            if (rooms[roomName]) {
                startNextRound(roomName, winnerId, winType);
            }
        }, 8000);
    } else {
        room.state.status = 'game_over';
    }
}

function startNextRound(roomName, winnerId, winType) {
    const room = rooms[roomName];
    if (!room) return;

    // 确定下一局庄家
    if (winType !== 'liuju' && winnerId !== null) {
        if (winnerId !== room.state.dealerId) {
            // 闲家胡牌，换庄
            room.state.dealerId = (room.state.dealerId + 1) % 4;
        }
        // 庄家胡牌则连庄，dealerId 不变
    } else {
        // 流局换庄
        room.state.dealerId = (room.state.dealerId + 1) % 4;
    }

    // 第 6、11 局：先选海克斯再开局
    if (room.state.roundNum === 6 || room.state.roundNum === 11) {
        room.state.status = 'hexselect';
        room.state.hexTier = getHexTierForRound(room.state.roundNum);
        room.state.deck = shuffle(createDeck());
        room.state.currentPlayerIndex = room.state.dealerId;
        room.state.turnCount = 1;
        room.state.lastDiscard = null;
        room.state.turnDiscarded = false;
        room.state.gangScores = {};
        room.pendingActions = {};
        room.players.forEach(player => {
            player.isBot = false;
            player.prism9Terminated = false;
            player.drawCountThisRound = 0;
            player.archmageUsedThisRound = false;
            player.hand = [];
            player.discards = [];
            player.peng = [];
            player.gang = [];
            player.isTing = false;
            player.silver3Used = false;
            player.goldNew5Used = false;
            for (let i = 0; i < 13; i++) {
                player.hand.push(room.state.deck.pop());
            }
            player.hand.sort();
            player.hextechOptions = generateHextechOptionsForTier(room.state.hexTier, player.hextechs || []);
        });
        room.players.forEach(player => {
            const publicState = {
                roomName: roomName,
                dealerId: room.state.dealerId,
                currentPlayerIndex: room.state.currentPlayerIndex,
                deckSize: room.state.deck.length,
                roundNum: room.state.roundNum,
                players: room.players.map(p => ({ id: p.id, name: p.name, score: p.score, handSize: p.hand.length }))
            };
            io.to(player.socketId).emit('gameStart', {
                ...publicState,
                myId: player.id,
                self: { hand: player.hand, hextechOptions: player.hextechOptions }
            });
            io.to(player.socketId).emit('hexOptions', { tier: room.state.hexTier, options: player.hextechOptions });
        });
        return;
    }

    // 非 6/11 局：直接开局
    room.state.status = 'playing';
    room.state.deck = shuffle(createDeck());
    room.state.currentPlayerIndex = room.state.dealerId;
    room.state.turnCount = 1;
    room.state.lastDiscard = null;
    room.state.turnDiscarded = false;
    room.state.gangScores = {}; // 重置杠分累积
    room.pendingActions = {};

    // 重置玩家手牌等
    room.players.forEach(player => {
        player.isBot = false;
        player.prism9Terminated = false;
        player.drawCountThisRound = 0;
        player.archmageUsedThisRound = false;
        player.hand = [];
        player.discards = [];
        player.peng = [];
        player.gang = [];
        player.isTing = false;
        player.silver3Used = false;
        player.goldNew5Used = false;
        // 注意：不重置 score, hextechs, consecutiveWins 等跨局数据
        
        for (let i = 0; i < 13; i++) {
            player.hand.push(room.state.deck.pop());
        }
        player.hand.sort();
    });

    room.state.codeInterferenceActive = false;
    room.state.codeInterferenceTurnsLeft = null;
    room.state.codeInterferenceConfusedUntilDiscard = null;

    const dealer = room.players[room.state.dealerId];
    // 大魔法师：庄家第一回合先摸一张牌，再触发交换（交换后不再摸牌）
    if (dealer.hextechs && dealer.hextechs.includes('prism_new_15') && !dealer.archmageUsedThisRound && !dealer.isBot) {
        const dealerDraw = drawTileFromDeck(room, dealer);
        if (dealerDraw) dealer.hand.push(dealerDraw);
        room.state.currentPlayerDrewThisTurn = true;
        room.waitingForArchmage = dealer.id;
        io.to(dealer.socketId).emit('archmageSwapRequest', { timeout: 15000 });
        room.archmageTimer = setTimeout(() => {
            const r = rooms[roomName];
            if (r && r.waitingForArchmage != null) {
                const pl = r.players.find(p => p.id === r.waitingForArchmage);
                if (pl) pl.archmageUsedThisRound = true;
                r.waitingForArchmage = null;
                if (r.archmageTimer) clearTimeout(r.archmageTimer);
                r.archmageTimer = null;
                if (_broadcastGameState) _broadcastGameState(roomName);
                if (pl && pl.isTing && _handleDiscard) {
                    setTimeout(() => {
                        const currentRoom = rooms[roomName];
                        if (currentRoom && currentRoom.state.currentPlayerIndex === pl.id && !currentRoom.state.turnDiscarded) {
                            const tileIndex = pl.hand.length - 1;
                            const tile = pl.hand[tileIndex];
                            _handleDiscard(roomName, null, tile, tileIndex, false);
                        }
                    }, 1000);
                } else if (_startTurnTimer) _startTurnTimer(roomName, pl.id);
            }
        }, 15000);
        if (_broadcastGameState) _broadcastGameState(roomName);
        return;
    }

    // 庄家摸第一张牌（天命眷顾：前三巡摸牌必为手中已有）
    const dealerDraw = drawTileFromDeck(room, dealer);
    if (dealerDraw) dealer.hand.push(dealerDraw);
    room.state.currentPlayerDrewThisTurn = true;

    if (_broadcastGameState) _broadcastGameState(roomName);
    else console.error('[startNextRound] broadcastGameState not ready');

    if (dealer.isTing && _handleDiscard) {
        setTimeout(() => {
            const currentRoom = rooms[roomName];
            if (currentRoom && currentRoom.state.currentPlayerIndex === dealer.id && !currentRoom.state.turnDiscarded) {
                const tileIndex = dealer.hand.length - 1;
                const tile = dealer.hand[tileIndex];
                _handleDiscard(roomName, null, tile, tileIndex, false);
            }
        }, 1000);
    } else if (_startTurnTimer) {
        _startTurnTimer(roomName, room.state.dealerId);
    }
}

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    // 监听加入房间事件（支持 playerId 断线重连）
    socket.on('join', ({ roomName, playerName, playerId: clientPlayerId }) => {
        const playerNameTrim = (playerName && String(playerName).trim()) || '玩家';
        console.log(`Received join request: player=${playerNameTrim}, room=${roomName}, playerId=${clientPlayerId || '(new)'}`);

        if (!rooms[roomName]) {
            rooms[roomName] = {
                id: roomName,
                players: [],
                state: {
                    status: 'waiting',
                    deck: [],
                    currentPlayerIndex: 0,
                    dealerId: 0,
                    turnCount: 0,
                    roundNum: 1,
                    lastDiscard: null
                },
                pendingActions: {}
            };
        }
        const room = rooms[roomName];

        // 统一用字符串比较 playerId，避免类型不一致导致匹配失败
        const clientPid = clientPlayerId != null ? String(clientPlayerId) : '';

        // 断线重连：优先用 playerId 匹配离线位，若无则用用户名相同匹配（只需同一房间+同一用户名即可重连）
        const tryReconnectById = (pid) => {
            if (!pid) return null;
            return room.players.find(
                p => p.playerId != null && String(p.playerId) === pid && p.isOffline === true
            );
        };
        const tryReconnectByName = (name) => {
            if (!name) return null;
            return room.players.find(
                p => p.name === name && p.isOffline === true
            );
        };
        const existing = tryReconnectById(clientPid) || tryReconnectByName(playerNameTrim);
        if (existing) {
            if (!existing.isOffline) {
                socket.emit('error', '该账号已在别处登录');
                return;
            }
            existing.socketId = socket.id;
            existing.isOffline = false;
            existing.isBot = false;
            existing.name = playerNameTrim; // 重连时可更新昵称
            socket.join(roomName);
            console.log(`[${roomName}] Reconnected: ${existing.name} (id=${existing.id}, playerId=${existing.playerId})`);
            socket.emit('reconnectSuccess', { playerId: existing.playerId, myId: existing.id });
            sendFullSnapshot(roomName, existing);
            io.to(roomName).emit('playerJoined', {
                players: room.players.map(p => ({ id: p.id, name: p.name, isOffline: p.isOffline }))
            });
            return;
        }

        // 新玩家：房间已满时再尝试一次按 playerId 或用户名接管离线位（避免多人断线时仅第一个能重连）
        if (room.players.length >= 4) {
            const existing2 = tryReconnectById(clientPid) || tryReconnectByName(playerNameTrim);
            if (existing2) {
                existing2.socketId = socket.id;
                existing2.isOffline = false;
                existing2.isBot = false;
                existing2.name = playerNameTrim;
                socket.join(roomName);
                console.log(`[${roomName}] Reconnected (before full): ${existing2.name} (id=${existing2.id}, playerId=${existing2.playerId})`);
                socket.emit('reconnectSuccess', { playerId: existing2.playerId, myId: existing2.id });
                sendFullSnapshot(roomName, existing2);
                io.to(roomName).emit('playerJoined', {
                    players: room.players.map(p => ({ id: p.id, name: p.name, isOffline: p.isOffline }))
                });
                return;
            }
            const offlineCount = room.players.filter(p => p.isOffline).length;
            socket.emit('error', offlineCount > 0
                ? '房间已满（当前有 ' + offlineCount + ' 人离线）。若您是断线玩家，请用相同用户名重新加入即可重连。'
                : '房间已满。若为断线重连，请使用相同用户名重新加入该房间。');
            return;
        }
        // 新玩家：该房间内已有相同用户名则拒绝
        const nameTaken = room.players.some(p => p.name === playerNameTrim);
        if (nameTaken) {
            socket.emit('error', '该用户名不可重复使用');
            return;
        }

        const newPlayerId = generatePlayerId();
        const player = {
            id: room.players.length,
            socketId: socket.id,
            playerId: newPlayerId,
            name: playerNameTrim,
            hand: [],
            discards: [],
            peng: [],
            gang: [],
            hextechs: [],
            score: 0,
            hextechOptions: [],
            isTing: false,
            wildcardTile: null,
            consecutiveWins: 0,
            reincarnationScore: 0,
            consecutiveNonDianpao: 0,
            isOffline: false,
            isBot: false
        };
        room.players.push(player);
        socket.join(roomName);
        socket.emit('playerIdAssigned', { playerId: newPlayerId });
        console.log(`${playerNameTrim} joined room ${roomName}, playerId=${newPlayerId}`);

        io.to(roomName).emit('playerJoined', {
            players: room.players.map(p => ({ id: p.id, name: p.name, isOffline: p.isOffline }))
        });

        if (room.players.length === 4) {
            console.log(`Room ${roomName} is full. Starting game...`);
            startGame(roomName);
        }
    });

    // 监听出牌事件
    socket.on('discard', ({ roomName, tile, tileIndex, isTing }) => {
        handleDiscard(roomName, socket, tile, tileIndex, isTing);
    });

    // 监听其他动作 (碰/杠/胡/选海克斯/过)
    socket.on('action', ({ roomName, type, data }) => {
        const room = rooms[roomName];
        if (!room) return;

        const player = room.players.find(p => p.socketId === socket.id);
        if (!player) return;

        console.log(`[${roomName}] Player ${player.id} performed action: ${type}`, data);

        // 取消托管：随时可点，仅联机 playing 有效
        if (type === 'cancelTakeover') {
            if (room.state.status !== 'playing') return;
            player.isBot = false;
            console.log(`[${roomName}] Player ${player.id} cancelled takeover.`);
            broadcastGameState(roomName);
            return;
        }

        // 如果游戏状态不是 playing，且不是选择海克斯，则忽略
        if (type !== 'selectHextech' && room.state.status !== 'playing') {
            console.log(`[${roomName}] Action ${type} ignored: status is ${room.state.status}`);
            return;
        }

        // 校验碰/杠/胡/过：仅当该玩家有待处理动作时才允许执行
        const myPending = room.pendingActions && room.pendingActions[player.id];
        const hasActionOfType = (t) => Array.isArray(myPending) && myPending.some(a => a && a.type === t);

        if (type === 'selectHextech') {
            let chosenId = data.hextechId;
            // 棱彩命运：从所有彩色海克斯（不含棱彩命运）中随机一个替换
            if (chosenId === PRISM_FATE_ID && PRISMATIC_OTHER.length > 0) {
                chosenId = PRISMATIC_OTHER[Math.floor(Math.random() * PRISMATIC_OTHER.length)];
                console.log(`[${roomName}] 棱彩命运 → 随机替换为 ${chosenId}`);
            }
            player.hextechs.push(chosenId);

            // Silver New 4: 红包开局 (+10)
            if (chosenId === 'silver_new_4') {
                player.score += 10;
                io.to(roomName).emit('systemMessage', `${player.name} 选择了【红包开局】，立即获得 10 积分！`);
            }
            if (data.hextechId === PRISM_FATE_ID && chosenId !== PRISM_FATE_ID) {
                io.to(roomName).emit('systemMessage', `${player.name} 的【棱彩命运】随机到了另一枚彩色海克斯！`);
            }

            io.to(roomName).emit('hextechSelected', {
                playerId: player.id,
                resolvedHextechId: chosenId
            });
            
            // 第1局选完每人1个，第6局选完每人2个，第11局选完每人3个（之前选的海克斯不清除，累积生效）
            const expectedCount = room.state.roundNum === 1 ? 1 : room.state.roundNum === 6 ? 2 : room.state.roundNum === 11 ? 3 : 1;
            const allSelected = room.players.every(p => p.hextechs.length >= expectedCount);
            if (allSelected) {
                io.to(roomName).emit('systemMessage', '所有玩家已选择海克斯，游戏开始！');
                room.state.status = 'playing';
                // 仅第 1 局选海克斯后设庄家；第 6、11 局庄家已在 startNextRound 中设好
                if (room.state.roundNum === 1) {
                    room.state.dealerId = 0;
                    room.state.currentPlayerIndex = room.state.dealerId;
                }
                room.state.turnCount = 1;
                
                const dealer = room.players[room.state.dealerId];
                if (dealer && room.state.deck.length > 0) {
                    if (dealer.hextechs && dealer.hextechs.includes('prism_new_15') && !dealer.archmageUsedThisRound && !dealer.isBot) {
                        const dealerDraw = drawTileFromDeck(room, dealer);
                        if (dealerDraw) dealer.hand.push(dealerDraw);
                        room.state.currentPlayerDrewThisTurn = true;
                        room.waitingForArchmage = dealer.id;
                        io.to(dealer.socketId).emit('archmageSwapRequest', { timeout: 15000 });
                        room.archmageTimer = setTimeout(() => {
                            const r = rooms[roomName];
                            if (r && r.waitingForArchmage != null) {
                                const pl = r.players.find(p => p.id === r.waitingForArchmage);
                                if (pl) pl.archmageUsedThisRound = true;
                                r.waitingForArchmage = null;
                                if (r.archmageTimer) clearTimeout(r.archmageTimer);
                                r.archmageTimer = null;
                                broadcastGameState(roomName);
                                if (pl && pl.isTing) {
                                    setTimeout(() => {
                                        const currentRoom = rooms[roomName];
                                        if (currentRoom && currentRoom.state.currentPlayerIndex === pl.id && !currentRoom.state.turnDiscarded) {
                                            const tileIndex = pl.hand.length - 1;
                                            const tile = pl.hand[tileIndex];
                                            handleDiscard(roomName, null, tile, tileIndex, false);
                                        }
                                    }, 1000);
                                } else {
                                    startTurnTimer(roomName, pl.id);
                                }
                            }
                        }, 15000);
                    } else {
                        const dealerDraw = drawTileFromDeck(room, dealer);
                        if (dealerDraw) dealer.hand.push(dealerDraw);
                        room.state.currentPlayerDrewThisTurn = true;
                    }
                }

                // Handle Prism New 2 (Wildcard)
                room.players.forEach(p => {
                    if (p.hextechs.includes('prism_new_2')) {
                        const types = [];
                        const suits = ['万', '筒', '条'];
                        const numbers = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
                        suits.forEach(s => numbers.forEach(n => types.push(n+s)));
                        ['东', '南', '西', '北'].forEach(w => types.push(w));
                        ['中', '发财', '白板'].forEach(d => types.push(d));
                        p.wildcardTile = types[Math.floor(Math.random() * types.length)];
                    } else {
                        p.wildcardTile = null;
                    }
                    p.goldNew5Used = false;
                });

                broadcastGameState(roomName);
                
                // 启动庄家回合处理（大魔法师等待交换时不要启动出牌计时器，否则会误触发托管/出牌）
                if (!room.waitingForArchmage) {
                    if (dealer.isTing) {
                        console.log(`[${roomName}] Dealer is Ting, auto discarding in 1s.`);
                        setTimeout(() => {
                            const currentRoom = rooms[roomName];
                            if (currentRoom && currentRoom.state.currentPlayerIndex === dealer.id && !currentRoom.state.turnDiscarded) {
                                const tileIndex = dealer.hand.length - 1;
                                const tile = dealer.hand[tileIndex];
                                handleDiscard(roomName, null, tile, tileIndex, false);
                            }
                        }, 1000);
                    } else {
                        startTurnTimer(roomName, room.state.dealerId);
                    }
                }
            }
        } 
        else if (type === 'hu') {
            if (room.state.lastDiscard && room.state.lastDiscard.isTingDiscard) {
                io.to(player.socketId).emit('error', '听牌打出的牌不可胡');
                return;
            }
            if (!hasActionOfType('hu')) {
                console.log(`[${roomName}] Player ${player.id} hu rejected: not in pendingActions`);
                io.to(player.socketId).emit('error', '当前不能胡牌');
                return;
            }
            if (room.actionTimer) clearTimeout(room.actionTimer);
            if (room.timer) clearTimeout(room.timer);
            
            const winType = (room.state.currentPlayerIndex === player.id) ? 'zimo' : 'dianpao';
            const loserId = (winType === 'zimo') ? null : room.state.lastDiscard.playerId;
            
            const { scoreChanges, summary } = calculateScoring(room, winType, player.id, loserId);
            
            handleRoundEnd(roomName, player.id, winType, loserId, scoreChanges, summary);
        }
        else if (type === 'peng') {
            if (room.state.lastDiscard && room.state.lastDiscard.isTingDiscard) {
                io.to(player.socketId).emit('error', '听牌打出的牌不可碰');
                return;
            }
            if (!hasActionOfType('peng')) {
                console.log(`[${roomName}] Player ${player.id} peng rejected: not in pendingActions`);
                io.to(player.socketId).emit('error', '当前不能碰牌');
                return;
            }
            if (!room.state.lastDiscard || !room.state.lastDiscard.tile) {
                console.log(`[${roomName}] Player ${player.id} peng rejected: no lastDiscard`);
                io.to(player.socketId).emit('error', '无效的碰牌请求');
                return;
            }
            if (room.actionTimer) clearTimeout(room.actionTimer);
            if (room.timer) clearTimeout(room.timer);

            const targetTile = room.state.lastDiscard.tile;
            if (targetTile) {
                let removed = 0;
                for (let i = player.hand.length - 1; i >= 0; i--) {
                    if (player.hand[i] === targetTile && removed < 2) {
                        player.hand.splice(i, 1);
                        removed++;
                    }
                }
                player.peng.push(targetTile);
                room.state.currentPlayerIndex = player.id;
                room.state.turnDiscarded = false; // 碰牌后允许出牌
                room.state.currentPlayerDrewThisTurn = false; // 碰牌得到回合，非摸牌
                
                // 广播动作语音
                io.to(roomName).emit('playerPerformedAction', {
                    playerId: player.id,
                    type: 'peng',
                    tile: targetTile
                });

                const lastPlayerId = room.state.lastDiscard.playerId;
                const lastPlayer = room.players.find(p => p.id === lastPlayerId);
                if (lastPlayer && lastPlayer.discards.length > 0) {
                    lastPlayer.discards.pop();
                }
                room.state.lastDiscard = null;
                room.pendingActions = {};
                // 代码干扰：碰牌后，除拥有者外每人“手牌混淆”直到该玩家自己出完牌才恢复
                if (room.players.some(p => p.hextechs && p.hextechs.includes('prism_new_16'))) {
                    room.state.codeInterferenceActive = true;
                    room.state.codeInterferenceConfusedUntilDiscard = {};
                    room.players.forEach(p => {
                        if (!p.hextechs || !p.hextechs.includes('prism_new_16')) {
                            room.state.codeInterferenceConfusedUntilDiscard[p.id] = true;
                        }
                    });
                }
                broadcastGameState(roomName);
            }
        }
        else if (type === 'archmageSwap') {
            if (!room.waitingForArchmage || room.waitingForArchmage !== player.id) {
                io.to(player.socketId).emit('error', '当前无需交换');
                return;
            }
            if (!player.hextechs || !player.hextechs.includes('prism_new_15')) {
                io.to(player.socketId).emit('error', '无大魔法师');
                return;
            }
            const indices = data.handIndices;
            if (!Array.isArray(indices) || indices.length !== 3) {
                io.to(player.socketId).emit('error', '请选择 3 张手牌');
                return;
            }
            const uniq = [...new Set(indices)];
            if (uniq.length !== 3) {
                io.to(player.socketId).emit('error', '请选择 3 张不同的手牌');
                return;
            }
            const valid = uniq.every(i => Number.isInteger(i) && i >= 0 && i < player.hand.length);
            if (!valid) {
                io.to(player.socketId).emit('error', '无效的手牌索引');
                return;
            }
            const others = room.players.filter(p => p.id !== player.id);
            if (others.length === 0) return;
            const opponent = others[Math.floor(Math.random() * others.length)];
            if (opponent.hand.length < 3) {
                io.to(player.socketId).emit('error', '对方手牌不足 3 张');
                return;
            }
            const [i0, i1, i2] = uniq;
            const myTiles = [player.hand[i0], player.hand[i1], player.hand[i2]];
            const oppIndices = [];
            while (oppIndices.length < 3) {
                const r = Math.floor(Math.random() * opponent.hand.length);
                if (!oppIndices.includes(r)) oppIndices.push(r);
            }
            const oppTiles = [opponent.hand[oppIndices[0]], opponent.hand[oppIndices[1]], opponent.hand[oppIndices[2]]];
            player.hand[i0] = oppTiles[0];
            player.hand[i1] = oppTiles[1];
            player.hand[i2] = oppTiles[2];
            oppIndices.sort((a, b) => b - a);
            for (const idx of oppIndices) opponent.hand.splice(idx, 1);
            opponent.hand.push(...myTiles);
            sortHand(opponent.hand);
            player.archmageUsedThisRound = true;
            room.waitingForArchmage = null;
            if (room.archmageTimer) clearTimeout(room.archmageTimer);
            room.archmageTimer = null;
            io.to(roomName).emit('systemMessage', `${player.name} 发动【大魔法师】与 ${opponent.name} 交换了 3 张手牌`);
            broadcastGameState(roomName);
            // 大魔法师：已先摸过牌，交换后不再摸牌，直接进入出牌阶段
            if (player.isTing && handleDiscard) {
                setTimeout(() => {
                    const currentRoom = rooms[roomName];
                    if (currentRoom && currentRoom.state.currentPlayerIndex === player.id && !currentRoom.state.turnDiscarded) {
                        const tileIndex = player.hand.length - 1;
                        const tile = player.hand[tileIndex];
                        handleDiscard(roomName, null, tile, tileIndex, false);
                    }
                }, 1000);
            } else if (startTurnTimer) {
                startTurnTimer(roomName, player.id);
            }
            return;
        }
        else if (type === 'gang') {
            if (room.state.lastDiscard && room.state.lastDiscard.isTingDiscard && (data.type === 'ming' || !data.type)) {
                io.to(player.socketId).emit('error', '听牌打出的牌不可杠');
                return;
            }
            if (room.actionTimer) clearTimeout(room.actionTimer);
            if (room.timer) clearTimeout(room.timer);
            const gangType = data.type || 'ming';
            const tile = data.tile || room.state.lastDiscard?.tile;

            // 明杠：必须由他人出牌触发，即 pendingActions 里要有 gang
            // 暗杠/补杠：在自己回合主动杠，不依赖 pendingActions
            const isMyTurn = (room.state.currentPlayerIndex === player.id);
            const canMingGang = hasActionOfType('gang');
            const canAnOrAddedGang = isMyTurn && (gangType === 'an' || gangType === 'added');

            if (gangType === 'ming') {
                if (!canMingGang) {
                    io.to(player.socketId).emit('error', '当前不能明杠（需他人打出该牌时选择杠）');
                    return;
                }
            } else if (gangType === 'an' || gangType === 'added') {
                if (!canAnOrAddedGang) {
                    io.to(player.socketId).emit('error', '暗杠/补杠只能在轮到自己出牌时进行');
                    return;
                }
                if (!tile) {
                    io.to(player.socketId).emit('error', '请指定要杠的牌');
                    return;
                }
                if (gangType === 'an') {
                    const count = player.hand.filter(t => t === tile).length;
                    if (count < 4) {
                        io.to(player.socketId).emit('error', '暗杠需要手牌中有 4 张相同牌');
                        return;
                    }
                } else {
                    const inPeng = player.peng.indexOf(tile) !== -1;
                    const inHand = player.hand.indexOf(tile) !== -1;
                    if (!inPeng || !inHand) {
                        io.to(player.socketId).emit('error', '补杠需要先碰过该牌且手牌中还有一张');
                        return;
                    }
                }
            } else {
                io.to(player.socketId).emit('error', '无效的杠类型');
                return;
            }

            // 听牌后仅允许暗杠或补杠，不允许明杠
            if (player.isTing && gangType === 'ming') {
                io.to(player.socketId).emit('error', '听牌后不能明杠');
                return;
            }
            
            // Prism New 8: 绝户计 (别人不能碰、不能杠) - 服务端二次校验
            if (gangType === 'ming' && room.state.lastDiscard) {
                const discarder = room.players.find(p => p.id === room.state.lastDiscard.playerId);
                if (discarder && discarder.hextechs.includes('prism_new_8')) {
                    return;
                }
            }

            // --- 杠分计算 (Standard Scoring) ---
            // 明杠: 点杠者付 1 分
            // 暗杠: 每家付 2 分
            // 补杠(Added): 每家付 1 分
            // Hextechs: Gold 1 (x2), Silver 6 (Added +1), Silver 1 (Ming +1)
            
            let baseScore = 0;
            let targets = []; // ids of players who pay
            const scoreUpdates = {}; // { pid: delta }

            // 1. Determine Base Score & Targets
            if (gangType === 'ming') {
                baseScore = 1;
                if (room.state.lastDiscard) {
                    targets.push(room.state.lastDiscard.playerId);
                }
            } else if (gangType === 'an') {
                baseScore = 2;
                room.players.forEach(p => { if(p.id !== player.id) targets.push(p.id); });
            } else if (gangType === 'added') {
                baseScore = 1;
                room.players.forEach(p => { if(p.id !== player.id) targets.push(p.id); });
            }

            // 2. Apply Hextech Modifiers
            // Gold 1: 疯狂杠精 (所有杠分翻倍)
            if (player.hextechs.includes('gold_1')) {
                baseScore *= 2;
                io.to(roomName).emit('systemMessage', `${player.name} 触发【疯狂杠精】，杠分翻倍！`);
            }

            // Silver 6: 补杠达人 (补杠时每家多付1分)
            let extraPerTarget = 0;
            if (gangType === 'added' && player.hextechs.includes('silver_6')) {
                extraPerTarget += 1;
                io.to(roomName).emit('systemMessage', `${player.name} 触发【补杠达人】，额外收取 1 分！`);
            }

            // 3. Apply Scores
            targets.forEach(targetId => {
                let payment = baseScore + extraPerTarget;
                
                // Silver 1: 杠头小利 (明杠额外+1) - 这是一个独立加成，不享受 Gold 1 翻倍
                if (gangType === 'ming' && player.hextechs.includes('silver_1')) {
                    payment += 1;
                    // Log handled below
                }

                // Update scores
                const target = room.players.find(p => p.id === targetId);
                if (target) {
                    target.score -= payment;
                    player.score += payment;
                    
                    // Log
                    if (gangType === 'ming' && player.hextechs.includes('silver_1')) {
                         io.to(roomName).emit('systemMessage', `${player.name} 触发【杠头小利】，额外收取 1 分！`);
                    }
                    
                    // Silver 12: 礼尚往来 (出牌被杠，对方补偿1分) - 反向补偿
                    if (gangType === 'ming' && target.hextechs.includes('silver_12')) {
                        player.score -= 1;
                        target.score += 1;
                        io.to(roomName).emit('systemMessage', `${target.name} 触发【礼尚往来】，获得 1 积分补偿！`);
                    }
                }
            });

            // Mark player as just ganged (for Gang Shang Pao check)
            player.justGanged = true;

            if (gangType === 'ming') {
                let removed = 0;
                for (let i = player.hand.length - 1; i >= 0; i--) {
                    if (player.hand[i] === tile && removed < 3) {
                        player.hand.splice(i, 1);
                        removed++;
                    }
                }
                player.gang.push(tile);
                room.state.currentPlayerIndex = player.id;
                room.state.turnDiscarded = false; // 杠牌后摸牌并允许出牌

                const lastPlayerId = room.state.lastDiscard.playerId;
                const lastPlayer = room.players.find(p => p.id === lastPlayerId);
                if (lastPlayer && lastPlayer.discards.length > 0) {
                    lastPlayer.discards.pop();
                }
                room.state.lastDiscard = null;
            } else if (gangType === 'an') {
                let removed = 0;
                for (let i = player.hand.length - 1; i >= 0; i--) {
                    if (player.hand[i] === tile && removed < 4) {
                        player.hand.splice(i, 1);
                        removed++;
                    }
                }
                player.gang.push(tile);
            } else if (gangType === 'added') {
                const pengIndex = player.peng.indexOf(tile);
                if (pengIndex !== -1) {
                    player.peng.splice(pengIndex, 1);
                    player.gang.push(tile);
                    removeOne(player.hand, tile);
                }
            }

            // 碰/杠/胡语音：明杠/暗杠/补杠统一在此广播，客户端播报「杠」
            io.to(roomName).emit('playerPerformedAction', {
                playerId: player.id,
                type: 'gang',
                tile: tile
            });

            if (room.state.deck.length > 0) {
                player.hand.push(room.state.deck.pop());
                // 杠后摸牌不排序，保持新牌在最右端
            }
            room.state.currentPlayerDrewThisTurn = true; // 杠后摸牌算本回合摸牌
            room.pendingActions = {};
            broadcastGameState(roomName);
        }
        else if (type === 'swap') {
            // 按请求区分：摸牌入门 = 只传 tile；资源回收 = 传 handTile + discardTile + discardIdx，避免同时拥有时摸牌入门被资源回收分支拦截
            const isSilver3Request = (data.tile != null || data.handTile != null) && data.discardTile == null && data.discardIdx == null;
            const isGoldNew5Request = data.handTile != null && data.discardTile != null;

            // Silver 3: 摸牌入门（每局轮到自己第一次出牌时：选一张手牌与牌堆随机一张交换）
            if (isSilver3Request && player.hextechs.includes('silver_3') && !player.silver3Used) {
                if (room.state.currentPlayerIndex !== player.id) {
                    io.to(player.socketId).emit('error', '【摸牌入门】只能在轮到自己出牌时使用');
                    return;
                }
                if (room.state.turnDiscarded) {
                    io.to(player.socketId).emit('error', '【摸牌入门】只能在出牌前使用');
                    return;
                }
                const handTile = data.tile != null ? data.tile : data.handTile;
                const hIdx = player.hand.indexOf(handTile);
                if (hIdx === -1 || room.state.deck.length === 0) {
                    io.to(player.socketId).emit('error', '【摸牌入门】请选择手牌中的一张牌');
                    return;
                }
                const randomIdx = Math.floor(Math.random() * room.state.deck.length);
                const newTile = room.state.deck[randomIdx];
                room.state.deck[randomIdx] = handTile;
                player.hand[hIdx] = newTile;
                player.silver3Used = true;
                sortHand(player.hand);
                io.to(roomName).emit('systemMessage', `【摸牌入门】交换成功！新牌为：${newTile}`);
                broadcastGameState(roomName);
                return;
            }
            // Gold New 5: 资源回收（轮到自己出牌时，手牌与弃牌区交换，每回合限一次）
            if (isGoldNew5Request && player.hextechs.includes('gold_new_5')) {
                if (player.goldNew5Used) {
                    io.to(player.socketId).emit('error', '【资源回收】每回合仅限使用一次');
                    return;
                }
                if (room.state.currentPlayerIndex !== player.id) {
                    io.to(player.socketId).emit('error', '【资源回收】只能在轮到自己出牌时使用');
                    return;
                }
                if (room.state.turnDiscarded) {
                    io.to(player.socketId).emit('error', '【资源回收】请在本回合出牌前使用');
                    return;
                }
                const handTile = data.handTile;
                const discardTile = data.discardTile;
                const discardIdx = typeof data.discardIdx === 'number' ? data.discardIdx : parseInt(data.discardIdx, 10);
                if (handTile == null || discardTile == null || !Number.isInteger(discardIdx) || discardIdx < 0) {
                    io.to(player.socketId).emit('error', '【资源回收】请先选择手牌再选择弃牌区的一张牌');
                    return;
                }
                const hIdx = player.hand.indexOf(handTile);
                if (hIdx === -1 || !player.discards[discardIdx] || player.discards[discardIdx] !== discardTile) {
                    io.to(player.socketId).emit('error', '【资源回收】手牌或弃牌不存在，请重试');
                    return;
                }
                player.hand[hIdx] = discardTile;
                player.discards[discardIdx] = handTile;
                player.goldNew5Used = true;
                sortHand(player.hand);
                io.to(roomName).emit('systemMessage', `${player.name} 使用【资源回收】交换了手牌！`);
                broadcastGameState(roomName);
                return;
            }
        }
        else if (type === 'pass') {
            // 仅当有待处理动作时才允许过（避免无关请求清空 pending）
            if (!myPending || myPending.length === 0) {
                console.log(`[${roomName}] Player ${player.id} pass ignored: no pending actions`);
                io.to(player.socketId).emit('error', '无需过');
                return;
            }
            delete room.pendingActions[player.id];
            
            // 特殊处理：如果是听牌玩家自摸选择了过
            if (room.state.pendingZimo && room.state.currentPlayerIndex === player.id) {
                 if (room.actionTimer) clearTimeout(room.actionTimer);
                 room.state.pendingZimo = false;
                 // 放弃自摸，自动出牌
                 const tileIndex = player.hand.length - 1;
                 const tile = player.hand[tileIndex];
                 // 简单的校验：确保手牌数量正确 (14张)
                 if (player.hand.length % 3 === 2) {
                     handleDiscard(roomName, null, tile, tileIndex, false);
                 } else {
                     // 异常情况，强制下一回合
                     moveToNextTurn(roomName);
                 }
                 return;
            }

            // 听牌后可选杠时选择了过：本回合是摸牌得到的，应自动出牌（打出一张）
            if (room.state.currentPlayerIndex === player.id && room.state.currentPlayerDrewThisTurn) {
                if (room.actionTimer) clearTimeout(room.actionTimer);
                const tileIndex = player.hand.length - 1;
                const tile = player.hand[tileIndex];
                if (player.hand.length % 3 === 2) {
                    handleDiscard(roomName, socket, tile, tileIndex, false);
                } else {
                    moveToNextTurn(roomName);
                }
                return;
            }

            // 如果所有有动作的玩家都过了，则继续下一回合
            if (Object.keys(room.pendingActions).length === 0) {
                if (room.actionTimer) clearTimeout(room.actionTimer);
                moveToNextTurn(roomName);
            }
        }

        broadcastGameState(roomName);
    });

    function moveToNextTurn(roomName) {
        const room = rooms[roomName];
        if (!room) return;
        
        // 代码干扰：每人“手牌混淆”在 handleDiscard 中该玩家出牌时单独清除，此处不再全局清除
        room.state.turnDiscarded = false;

        if (room.timer) clearTimeout(room.timer);
        if (room.actionTimer) clearTimeout(room.actionTimer);
        if (room.turnTimer) clearTimeout(room.turnTimer);

        if (room.state.currentPlayerIndex === room.state.dealerId) {
             room.state.turnCount++;
        }

        // Prism New 5: 孤注一掷 (报听后跳过摸牌，只能等点炮)
        // 寻找下一个合法的玩家
        let attempts = 0;
        do {
            room.state.currentPlayerIndex = (room.state.currentPlayerIndex + 1) % 4;
            attempts++;
            
            const nextP = room.players[room.state.currentPlayerIndex];
            // 如果玩家有【孤注一掷】且已听牌，跳过他的回合
            if (nextP.hextechs.includes('prism_new_5') && nextP.isTing) {
                // Skip
                continue;
            }
            // 找到了合法的玩家
            break;
        } while (attempts < 5); // 防止死循环 (虽不太可能4人都skip)

        if (attempts >= 5) {
            // 极度罕见：所有人都跳过？直接流局或强制给某人
            console.log(`[${roomName}] All players skipped (Prism New 5), forcing dealer.`);
            room.state.currentPlayerIndex = room.state.dealerId;
        }
        
        if (room.state.deck.length === 0) {
             const { scoreChanges, summary } = calculateScoring(room, 'liuju', null, null);
             handleRoundEnd(roomName, null, 'liuju', null, scoreChanges, summary);
        } else {
             const nextPlayer = room.players[room.state.currentPlayerIndex];
             
             // Prism New 15: 大魔法师 (先摸一张再选3张与随机对手换3张，交换后不再摸牌)
             if (nextPlayer.hextechs && nextPlayer.hextechs.includes('prism_new_15') && !nextPlayer.archmageUsedThisRound && !nextPlayer.isBot) {
                 const drawnTile = drawTileFromDeck(room, nextPlayer);
                 if (drawnTile) nextPlayer.hand.push(drawnTile);
                 room.state.currentPlayerDrewThisTurn = true;
                 room.waitingForArchmage = nextPlayer.id;
                 io.to(nextPlayer.socketId).emit('archmageSwapRequest', { timeout: 15000 });
                 room.archmageTimer = setTimeout(() => {
                     const r = rooms[roomName];
                     if (r && r.waitingForArchmage !== undefined && r.waitingForArchmage !== null) {
                         const pl = r.players.find(p => p.id === r.waitingForArchmage);
                         if (pl) pl.archmageUsedThisRound = true;
                         r.waitingForArchmage = null;
                         r.archmageTimer = null;
                         broadcastGameState(roomName);
                         if (pl && pl.isTing) {
                             setTimeout(() => {
                                 const currentRoom = rooms[roomName];
                                 if (currentRoom && currentRoom.state.currentPlayerIndex === pl.id && !currentRoom.state.turnDiscarded) {
                                     const tileIndex = pl.hand.length - 1;
                                     const tile = pl.hand[tileIndex];
                                     handleDiscard(roomName, null, tile, tileIndex, false);
                                 }
                             }, 1000);
                         } else {
                             startTurnTimer(roomName, pl.id);
                         }
                     }
                 }, 15000);
                 broadcastGameState(roomName);
                 return;
             }

             doDrawAndStartTurn(roomName);
        }
        
        broadcastGameState(roomName);
    }

    function doDrawAndStartTurn(roomName) {
        const room = rooms[roomName];
        if (!room) return;
        const nextPlayer = room.players[room.state.currentPlayerIndex];
        
        if (room.state.deck.length === 0) {
            const { scoreChanges, summary } = calculateScoring(room, 'liuju', null, null);
            handleRoundEnd(roomName, null, 'liuju', null, scoreChanges, summary);
            return;
        }

        const drawnTile = drawTileFromDeck(room, nextPlayer);
        if (drawnTile) nextPlayer.hand.push(drawnTile);
        room.state.currentPlayerDrewThisTurn = true;
             // 资源回收：仅每局开始时重置（见 startNextRound），本局内每回合限用一次，不在摸牌时重置
             
             // 检查自摸 (听牌玩家必须由后端检查并给机会)
             let canZimo = false;
             if (nextPlayer.isTing) {
                 if (checkWin(nextPlayer.hand, nextPlayer.peng, nextPlayer.gang, nextPlayer.wildcardTile)) {
                     canZimo = true;
                 }
             }

             if (nextPlayer.isBot) {
                 // AI 托管：2 秒后自动打出最后一张牌（不碰不胡，只出牌）
                 const delay = 2000;
                 console.log(`[${roomName}] Bot ${nextPlayer.id} auto discarding in ${delay / 1000}s.`);
                 setTimeout(() => {
                     const currentRoom = rooms[roomName];
                     if (currentRoom && currentRoom.state.currentPlayerIndex === nextPlayer.id && !currentRoom.state.turnDiscarded) {
                         const tileIndex = nextPlayer.hand.length - 1;
                         const tile = nextPlayer.hand[tileIndex];
                         handleDiscard(roomName, null, tile, tileIndex, false);
                     }
                 }, delay);
             } else if (nextPlayer.isTing) {
                 if (canZimo) {
                     console.log(`[${roomName}] Player ${nextPlayer.id} is Ting and Zimo! Sending option.`);
                     const actions = { [nextPlayer.id]: [{ type: 'hu', data: { tile: drawnTile } }] };
                     room.pendingActions = actions;
                     room.state.pendingZimo = true;
                    io.to(nextPlayer.socketId).emit('availableActions', {
                        actions: actions[nextPlayer.id],
                        discardedTile: drawnTile,
                        discarderId: nextPlayer.id,
                        isZimo: true,
                        timeout: 8000
                    });
                    room.actionTimer = setTimeout(() => {
                        room.pendingActions = {};
                        if (rooms[roomName]) {
                            const tileIndex = nextPlayer.hand.length - 1;
                            const tile = nextPlayer.hand[tileIndex];
                            handleDiscard(roomName, null, tile, tileIndex, false);
                        }
                    }, 8000);
                 } else {
                     // 听牌后若可杠（暗杠/补杠），给 8 秒选择时间，时间到自动过
                     const gangOptions = getGangOptionsForTingPlayer(nextPlayer);
                     if (gangOptions.length > 0) {
                         const actions = gangOptions.map(opt => ({ type: 'gang', data: { type: opt.type, tile: opt.tile } }));
                         actions.push({ type: 'pass' });
                         room.pendingActions = { [nextPlayer.id]: actions };
                         io.to(nextPlayer.socketId).emit('availableActions', {
                             actions: actions,
                             discarderId: nextPlayer.id,
                             isZimo: false,
                             timeout: 8000
                         });
                         room.actionTimer = setTimeout(() => {
                             room.pendingActions = {};
                             if (rooms[roomName]) {
                                 const tileIndex = nextPlayer.hand.length - 1;
                                 const tile = nextPlayer.hand[tileIndex];
                                 handleDiscard(roomName, null, tile, tileIndex, false);
                             }
                         }, 8000);
                     } else {
                         console.log(`[${roomName}] Player ${nextPlayer.id} is Ting, auto discarding in 1s.`);
                         setTimeout(() => {
                             const currentRoom = rooms[roomName];
                             if (currentRoom && currentRoom.state.currentPlayerIndex === nextPlayer.id && !currentRoom.state.turnDiscarded) {
                                 const tileIndex = nextPlayer.hand.length - 1;
                                 const tile = nextPlayer.hand[tileIndex];
                                 handleDiscard(roomName, null, tile, tileIndex, false);
                             }
                         }, 1000);
                     }
                 }
             } else {
                 startTurnTimer(roomName, nextPlayer.id);
             }

        broadcastGameState(roomName);
    }

    function startTurnTimer(roomName, playerId) {
        const room = rooms[roomName];
        if (!room) return;
        if (room.turnTimer) clearTimeout(room.turnTimer);

        room.turnTimer = setTimeout(() => {
            const player = room.players.find(p => p.id === playerId);
            if (player && room.state.currentPlayerIndex === playerId) {
                // 出牌超时：接入 AI 托管（后续由托管逻辑自动出牌），不再只打一张
                player.isBot = true;
                const tileIndex = player.hand.length - 1;
                const tile = player.hand[tileIndex];
                console.log(`[${roomName}] Player ${playerId} discard timeout, entering AI takeover, auto discarding ${tile}`);
                handleDiscard(roomName, socketByPlayerId(room, playerId), tile, tileIndex, false);
            }
        }, 20000); // 20秒超时
    }

    // 辅助：根据玩家ID获取其对应的socket
    function socketByPlayerId(room, playerId) {
        const player = room.players.find(p => p.id === playerId);
        return player ? io.sockets.sockets.get(player.socketId) : null;
    }

    // 将出牌逻辑抽离出来，方便定时器调用
    function handleDiscard(roomName, socket, tile, tileIndex, isTing) {
        const room = rooms[roomName];
        if (!room) return;
        
        // 如果游戏不在进行中（如等待下一局），则禁止出牌
        if (room.state.status !== 'playing') {
            console.log(`[${roomName}] Discard ignored: game status is ${room.state.status}`);
            return;
        }

        // 安全清理自摸标记
        if (room.state.pendingZimo) room.state.pendingZimo = false;

        // 如果该回合已经处理过出牌，则拒绝（防止连点或逻辑重叠）
        if (room.state.turnDiscarded) {
            console.log(`[${roomName}] Discard ignored: already discarded in this turn.`);
            return;
        }

        // 立即清理回合定时器
        if (room.turnTimer) {
            clearTimeout(room.turnTimer);
            room.turnTimer = null;
        }

        // 有 socket 时按 socket 找玩家，否则按当前回合玩家（如超时自动出牌）
        const player = socket
            ? room.players.find(p => p.socketId === socket.id)
            : room.players.find(p => p.id === room.state.currentPlayerIndex);
        if (!player) return;

        // 有 socket 时必须是我方回合才能出牌
        if (socket && player.id !== room.state.currentPlayerIndex) {
            return;
        }

        let realIndex = -1;
        if (tile) {
            realIndex = player.hand.indexOf(tile);
        }
        if (realIndex === -1 && typeof tileIndex === 'number') {
             realIndex = tileIndex;
        }
        if (realIndex === -1 || realIndex >= player.hand.length) return;

        // 标记该回合已出牌
        room.state.turnDiscarded = true;

        const discardedTile = player.hand[realIndex];
        player.hand.splice(realIndex, 1);
        player.discards.push(discardedTile);
        
        // 出牌后才进行排序，保持手牌整齐
        sortHand(player.hand);

        if (isTing) player.isTing = true;
        
        room.state.lastDiscard = {
            playerId: player.id,
            tile: discardedTile,
            tileIndex: realIndex,
            isTingDiscard: !!isTing,
            isGangDiscard: !!player.justGanged
        };
        
        // Reset justGanged flag
        player.justGanged = false;

        // 十三幺契约：本回合打完牌后立刻检测手牌（13张），无对子+1分，有对子则终止且本局不再生效
        if (player.hextechs && player.hextechs.includes('prism_9') && !player.prism9Terminated && player.discards.length > 0) {
            const counts = {};
            player.hand.forEach(t => counts[t] = (counts[t] || 0) + 1);
            const hasPairs = Object.values(counts).some(c => c >= 2);
            if (hasPairs) {
                player.prism9Terminated = true;
                io.to(player.socketId).emit('systemMessage', `【十三幺契约】手牌出现对子，契约终止`);
            } else {
                player.score += 1;
                io.to(player.socketId).emit('systemMessage', `【十三幺契约】生效中，本巡 +1 分`);
            }
        }

        io.to(roomName).emit('playerDiscarded', {
            playerId: player.id,
            tile: discardedTile,
            tileIndex: realIndex,
            isTing: !!isTing // 仅在报听的那次出牌为 true
        });

        // 代码干扰：该玩家出完牌后，仅解除该玩家自己的手牌混淆
        if (room.state.codeInterferenceConfusedUntilDiscard && room.state.codeInterferenceConfusedUntilDiscard[player.id]) {
            room.state.codeInterferenceConfusedUntilDiscard[player.id] = false;
            const stillConfused = Object.values(room.state.codeInterferenceConfusedUntilDiscard).some(v => v);
            if (!stillConfused) room.state.codeInterferenceActive = false;
        }
        
        const availableActions = checkActionsAfterDiscard(room, discardedTile, player.id);
        room.pendingActions = availableActions;

        if (Object.keys(availableActions).length > 0) {
            const botOnly = Object.keys(availableActions).every(pid => {
                const p = room.players.find(x => x.id === parseInt(pid));
                return p && p.isBot;
            });
            if (botOnly) {
                room.pendingActions = {};
                setTimeout(() => moveToNextTurn(roomName), 500);
            } else {
                for (const [pid, actions] of Object.entries(availableActions)) {
                    const p = room.players.find(x => x.id === parseInt(pid));
                    if (p && !p.isBot) {
                        console.log(`[${roomName}] Sending availableActions to player ${p.id}:`, actions);
                        io.to(p.socketId).emit('availableActions', {
                            actions: actions,
                            discardedTile: discardedTile,
                            discarderId: player.id,
                            timeout: 8000
                        });
                    }
                }
                room.actionTimer = setTimeout(() => {
                    console.log(`[${roomName}] Action timeout, moving to next turn.`);
                    room.pendingActions = {};
                    moveToNextTurn(roomName);
                }, 8000);
            }
        } else {
            room.timer = setTimeout(() => {
                moveToNextTurn(roomName);
            }, 800);
        }
        broadcastGameState(roomName);
    }

    // 为某一玩家构建完整游戏状态（用于广播与重连快照）
    function getStateForRecipient(roomName, room, recipient) {
        const canSeeAll = recipient.hextechs.includes('prism_new_4');
        const canSeeThree = recipient.hextechs.includes('gold_new_8');
        const publicState = {
            roomName: roomName,
            dealerId: room.state.dealerId,
            currentPlayerIndex: room.state.currentPlayerIndex,
            deckSize: room.state.deck.length,
            lastDiscard: room.state.lastDiscard,
            turnCount: room.state.turnCount,
            roundNum: room.state.roundNum,
            currentPlayerDrewThisTurn: !!room.state.currentPlayerDrewThisTurn,
            codeInterferenceActive: !!room.state.codeInterferenceActive,
            confuseMyHand: !!(room.state.codeInterferenceConfusedUntilDiscard && room.state.codeInterferenceConfusedUntilDiscard[recipient.id]),
            waitingForArchmage: room.waitingForArchmage != null ? room.waitingForArchmage : undefined,
            pendingActions: room.pendingActions,
            players: room.players.map(p => {
                let visibleHand = null;
                if (p.id !== recipient.id) {
                    if (canSeeAll) visibleHand = p.hand;
                    else if (canSeeThree) visibleHand = p.hand.map((tile, idx) => idx < 3 ? tile : null);
                }
                return {
                    id: p.id,
                    name: p.name,
                    score: p.score,
                    handSize: p.hand.length,
                    hand: visibleHand,
                    discards: p.discards,
                    peng: p.peng,
                    gang: p.gang,
                    hextechs: p.hextechs,
                    wildcardTile: p.wildcardTile,
                    isTing: p.isTing
                };
            })
        };
        return {
            ...publicState,
            self: {
                hand: recipient.hand,
                hextechOptions: recipient.hextechOptions,
                silver3Used: recipient.silver3Used,
                goldNew5Used: recipient.goldNew5Used,
                isTakeover: !!recipient.isBot
            }
        };
    }

    // 重连成功后发送完整游戏快照
    function sendFullSnapshot(roomName, player) {
        const room = rooms[roomName];
        if (!room) return;
        if (room.state.status === 'waiting') {
            io.to(player.socketId).emit('playerJoined', {
                players: room.players.map(p => ({ id: p.id, name: p.name, isOffline: p.isOffline }))
            });
            return;
        }
        if (room.state.status === 'hexselect') {
            const publicState = {
                roomName: roomName,
                dealerId: room.state.dealerId,
                currentPlayerIndex: room.state.currentPlayerIndex,
                deckSize: room.state.deck.length,
                players: room.players.map(p => ({ id: p.id, name: p.name, score: p.score, handSize: p.hand.length }))
            };
            io.to(player.socketId).emit('gameStart', {
                ...publicState,
                myId: player.id,
                self: { hand: player.hand, hextechOptions: player.hextechOptions }
            });
            io.to(player.socketId).emit('hexOptions', { tier: room.state.hexTier, options: player.hextechOptions });
            return;
        }
        if (room.state.status === 'playing') {
            io.to(player.socketId).emit('updateState', getStateForRecipient(roomName, room, player));
        }
    }

    // 辅助：广播状态（仅发给在线玩家）
    function broadcastGameState(roomName) {
        const room = rooms[roomName];
        if (!room) return;
        room.players.filter(p => !p.isOffline).forEach(recipient => {
            io.to(recipient.socketId).emit('updateState', getStateForRecipient(roomName, room, recipient));
        });
    }

    // 供 startNextRound（模块顶层）调用的引用，否则 8 秒后无法广播下一局
    _broadcastGameState = broadcastGameState;
    _startTurnTimer = startTurnTimer;
    _handleDiscard = handleDiscard;

    socket.on('disconnect', (reason) => {
        console.log('玩家断开原因:', reason, '(socket.id:', socket.id + ')');
        for (const roomName of Object.keys(rooms)) {
            const room = rooms[roomName];
            const player = room.players.find(p => p.socketId === socket.id);
            if (player) {
                player.isOffline = true;
                player.isBot = true;
                console.log(`[${roomName}] Player ${player.name} (id=${player.id}) marked offline, AI takeover.`);
                io.to(roomName).emit('playerJoined', {
                    players: room.players.map(p => ({ id: p.id, name: p.name, isOffline: p.isOffline }))
                });
                // 内存优化：若该房间已无在线玩家，删除房间并清理定时器，避免泄漏
                const onlineCount = room.players.filter(p => !p.isOffline).length;
                if (onlineCount === 0) {
                    if (room.timer) clearTimeout(room.timer);
                    if (room.actionTimer) clearTimeout(room.actionTimer);
                    if (room.turnTimer) clearTimeout(room.turnTimer);
                    delete rooms[roomName];
                    console.log(`[${roomName}] 房间已无在线玩家，已删除房间释放内存`);
                }
                break;
            }
        }
    });
});

// 游戏开始逻辑
function startGame(roomName) {
    const room = rooms[roomName];
    room.state.status = 'hexselect';
    
    // 1. 洗牌
    room.state.deck = shuffle(createDeck());
    
    // A. 第一个海克斯必为彩色，第二、三个随机
    room.state.hexTier = getHexTierForRound(1);
    
    room.players.forEach(player => {
        player.isBot = false;
        player.prism9Terminated = false;
        player.drawCountThisRound = 0;
        player.archmageUsedThisRound = false;
        player.hand = [];
        player.discards = [];
        player.peng = [];
        player.gang = [];
        player.isTing = false;
        player.silver3Used = false;
        player.consecutiveNonDianpao = 0;
        
        for (let i = 0; i < 13; i++) {
            player.hand.push(room.state.deck.pop());
        }
        player.hand.sort();
        
        // 3. 生成海克斯选项（统一等级，排除已选同等级避免重复）
        player.hextechOptions = generateHextechOptionsForTier(room.state.hexTier, player.hextechs || []);
    });

    room.state.dealerId = 0; 
    room.state.currentPlayerIndex = room.state.dealerId;
    
    // 清理之前的定时器
    if (room.timer) clearTimeout(room.timer);
    if (room.actionTimer) clearTimeout(room.actionTimer);
    if (room.turnTimer) clearTimeout(room.turnTimer);

    // 5. 广播游戏开始
    // 向每个玩家发送私有信息 (手牌、海克斯选项) 和 公共信息
    room.players.forEach(player => {
        const publicState = {
            roomName: roomName,
            dealerId: room.state.dealerId,
            currentPlayerIndex: room.state.currentPlayerIndex,
            deckSize: room.state.deck.length,
            players: room.players.map(p => ({
                id: p.id,
                name: p.name,
                score: p.score,
                handSize: p.hand.length // 不发送其他人手牌具体内容
            }))
        };

        io.to(player.socketId).emit('gameStart', {
            ...publicState,
            myId: player.id,
            playerId: player.playerId,
            self: {
                hand: player.hand,
                hextechOptions: player.hextechOptions,
                playerId: player.playerId
            }
        });
        // Explicitly emit hexOptions + tier 以便前端提示等级
        io.to(player.socketId).emit('hexOptions', {
            tier: room.state.hexTier,
            options: player.hextechOptions
        });
    });
}

// 端口设置
const PORT = parseInt(process.env.PORT, 10) || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log('服务器已在 0.0.0.0:' + PORT + ' 启动');
});
