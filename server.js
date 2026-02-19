const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname)));

const players      = new Map(); // socketId → { id, name, symbol, level }
const worldPlayers = new Map(); // socketId → { id, name, symbol, level, pos, inBattle }
const pending      = new Map(); // targetId  → { fromId, timer }
const duels        = new Map(); // socketId  → { opponentId, dcTimer }

function broadcastWorld() {
    io.emit('worldUpdate', Array.from(worldPlayers.values()));
}

function cleanupDuel(idA, idB) {
    [idA, idB].forEach(id => {
        const d = duels.get(id);
        if (d?.dcTimer) clearTimeout(d.dcTimer);
        duels.delete(id);
        const w = worldPlayers.get(id);
        if (w) w.inBattle = false;
    });
    broadcastWorld();
}

io.on('connection', socket => {
    socket.on('register', data => {
        players.set(socket.id, { id: socket.id, name: data.name, symbol: data.symbol, level: data.level });
    });

    socket.on('enterWorld', pos => {
        const p = players.get(socket.id);
        if (!p) return;
        worldPlayers.set(socket.id, { ...p, pos, inBattle: false });
        broadcastWorld();
    });

    socket.on('leaveWorld', () => { worldPlayers.delete(socket.id); broadcastWorld(); });

    socket.on('setBattle', on => {
        const w = worldPlayers.get(socket.id);
        if (w) { w.inBattle = on; broadcastWorld(); }
    });

    socket.on('requestDuel', targetId => {
        const me = worldPlayers.get(socket.id);
        const tgt = worldPlayers.get(targetId);
        if (!me || !tgt || tgt.inBattle || pending.has(targetId)) {
            socket.emit('reqFailed', !tgt ? 'Player left.' : tgt.inBattle ? 'Player is in a duel.' : 'Player has a pending request.');
            return;
        }
        const timer = setTimeout(() => {
            pending.delete(targetId);
            socket.emit('reqExpired');
            io.to(targetId).emit('reqTimedOut');
        }, 30000);
        pending.set(targetId, { fromId: socket.id, timer });
        io.to(targetId).emit('incomingReq', { fromId: socket.id, name: me.name, symbol: me.symbol, level: me.level });
        socket.emit('reqSent');
    });

    socket.on('cancelReq', targetId => {
        const req = pending.get(targetId);
        if (req?.fromId === socket.id) { clearTimeout(req.timer); pending.delete(targetId); io.to(targetId).emit('reqTimedOut'); }
    });

    socket.on('respondReq', accepted => {
        const req = pending.get(socket.id);
        if (!req) return;
        clearTimeout(req.timer);
        pending.delete(socket.id);
        if (!accepted) { io.to(req.fromId).emit('reqDeclined'); return; }

        const wA = worldPlayers.get(req.fromId);
        const wB = worldPlayers.get(socket.id);
        if (wA) wA.inBattle = true;
        if (wB) wB.inBattle = true;
        broadcastWorld();

        duels.set(req.fromId, { opponentId: socket.id });
        duels.set(socket.id,  { opponentId: req.fromId });

        io.to(req.fromId).emit('pvpStart', {
            role: 'A', opponentId: socket.id,
            name: wB?.name, symbol: wB?.symbol, level: wB?.level
        });
        io.to(socket.id).emit('pvpStart', {
            role: 'B', opponentId: req.fromId,
            name: wA?.name, symbol: wA?.symbol, level: wA?.level
        });
    });

    // All mid-duel events are relayed verbatim to the opponent
    ['rpsChoice','pvpAction','pvpEnd'].forEach(evt => {
        socket.on(evt, data => {
            const d = duels.get(socket.id);
            if (d) io.to(d.opponentId).emit(evt, data);
        });
    });

    socket.on('disconnect', () => {
        const d = duels.get(socket.id);
        if (d) {
            io.to(d.opponentId).emit('oppDisconnected');
            const dcTimer = setTimeout(() => {
                io.to(d.opponentId).emit('pvpEnd', { won: true, reason: 'Opponent disconnected.' });
                cleanupDuel(socket.id, d.opponentId);
            }, 20000);
            const oppDuel = duels.get(d.opponentId);
            if (oppDuel) oppDuel.dcTimer = dcTimer;
            duels.delete(socket.id);
        }
        // Cancel any pending request this player sent
        pending.forEach((req, targetId) => {
            if (req.fromId === socket.id) { clearTimeout(req.timer); pending.delete(targetId); io.to(targetId).emit('reqTimedOut'); }
        });
        if (pending.has(socket.id)) {
            const req = pending.get(socket.id);
            clearTimeout(req.timer); pending.delete(socket.id);
            io.to(req.fromId).emit('reqExpired');
        }
        worldPlayers.delete(socket.id);
        players.delete(socket.id);
        broadcastWorld();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Neon Duelist server :' + PORT));