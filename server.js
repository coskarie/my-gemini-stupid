const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 방 데이터 저장소
const rooms = {};

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

io.on('connection', (socket) => {
    let currentRoom = null;
    let userName = "";

    // 1. 방 입장
    socket.on('joinRoom', (data) => {
        const { roomCode, name } = data;
        currentRoom = roomCode;
        userName = name;
        socket.join(roomCode);

        if (!rooms[roomCode]) {
            rooms[roomCode] = {
                players: [], 
                spectators: [], 
                gameState: 'LOBBY',
                phraseCount: 0,
                turn: null
            };
        }

        rooms[roomCode].spectators.push({ id: socket.id, name: userName });
        updateRoomInfo(roomCode);
        io.to(roomCode).emit('systemMsg', `${userName}님이 입장하셨습니다.`);
    });

    // 2. 역할 변경 (플레이어 <-> 관전자)
    socket.on('changeRole', (role) => {
        if (!currentRoom) return;
        const room = rooms[currentRoom];
        if (room.gameState !== 'LOBBY') return;

        room.players = room.players.filter(p => p.id !== socket.id);
        room.spectators = room.spectators.filter(s => s.id !== socket.id);

        if (role === 'player') {
            if (room.players.length < 2) {
                room.players.push({ 
                    id: socket.id, 
                    name: userName, 
                    isReady: false, 
                    units: [], 
                    placed: false 
                });
            } else {
                socket.emit('systemMsg', '플레이어 자리가 꽉 찼습니다.');
                room.spectators.push({ id: socket.id, name: userName });
            }
        } else {
            room.spectators.push({ id: socket.id, name: userName });
        }
        updateRoomInfo(currentRoom);
    });

    // 3. 준비 완료 버튼 토글
    socket.on('toggleReady', () => {
        const room = rooms[currentRoom];
        if (!room || room.gameState !== 'LOBBY') return;
        
        const player = room.players.find(p => p.id === socket.id);
        if (player) {
            player.isReady = !player.isReady;
            updateRoomInfo(currentRoom);
        }
    });

    // 4. 게임 시작 버튼
    socket.on('startGame', () => {
        const room = rooms[currentRoom];
        if (!room) return;
        
        if (room.players.length === 2 && room.players.every(p => p.isReady)) {
            room.gameState = 'PLACING';
            io.to(currentRoom).emit('startPlacing');
            updateRoomInfo(currentRoom);
        } else {
            socket.emit('systemMsg', '모든 플레이어가 준비되어야 시작할 수 있습니다.');
        }
    });

    // 5. 배치 및 전술 기동 확정 로직
    socket.on('finishPlacing', (units) => {
        const room = rooms[currentRoom];
        
        if (!room || (room.gameState !== 'PLACING' && room.gameState !== 'MOVING')) return;
        
        const player = room.players.find(p => p.id === socket.id);
        if (player) {
            player.units = units;
            player.placed = true;
        }

        if (room.players.length === 2 && room.players.every(p => p.placed)) {
            const prevState = room.gameState;
            room.gameState = 'PLAYING';
            room.players.forEach(p => p.placed = false);

            if (prevState === 'PLACING') {
                room.players.forEach(p => { p.maxFuel = 8; p.fuel = 8; });
                
                const turnIndex = Math.floor(Math.random() * 2);
                room.turn = room.players[turnIndex].id;
                
                passTurn(room, room.turn);
                
                io.to(currentRoom).emit('gameStart', { turn: room.turn });
                io.to(currentRoom).emit('systemMsg', "전투 시작! 선공을 확인하세요.");
            } else {
                io.to(currentRoom).emit('gameStart', { turn: room.turn });
                io.to(currentRoom).emit('systemMsg', "전술 기동 완료! 전투를 재개합니다.");
            }
            updateRoomInfo(currentRoom);
        } else {
            socket.emit('systemMsg', "상대방의 작전 완료를 기다리는 중입니다...");
        }
    });

    // 6. 특수 능력 판정 공격 로직 (🚨 5프레이즈 기동 데이터 즉시 동기화)
    socket.on('attack', (data) => {
        const room = rooms[currentRoom];
        if (!room || room.gameState !== 'PLAYING' || room.turn !== socket.id) return;

        const { index, type } = data;
        const attackIndex = index; // 내가 클릭한 칸 (0~199)
        const attackX = attackIndex % 20; // 내가 클릭한 열 (0~19)
        
        // 🎯 상대방 시점의 좌표 (180도 회전)
        const targetIndex = 199 - attackIndex; 
        const targetX = targetIndex % 20;
        const targetY = Math.floor(targetIndex / 20);

        // 🚨 서버 메모리에서 최신 유닛 정보를 가진 플레이어 객체를 새로 가져옴
        const attacker = room.players.find(p => p.id === socket.id);
        const opponent = room.players.find(p => p.id !== socket.id);

        // 🔫 SNIPE (저격) 검증
        if (type === 'SNIPE') {
            if (attacker.fuel < 1) return socket.emit('systemMsg', "연료가 부족하여 저격할 수 없습니다.");
            
            // 🚨 핵심: 5프레이즈에서 이동되어 서버에 저장된 '최신 units' 배열을 뒤집니다.
            const hasLineOfSight = attacker.units.some(u => {
                if (u.type !== 'I') return false; // 오직 저격수(I)만 체크
                
                const isAlive = u.cells.length > (u.hitCells ? u.hitCells.length : 0);
                // 5프레이즈에서 이동된 '새 좌표(cells)' 중 하나라도 현재 클릭한 열(attackX)과 일치하는가?
                return isAlive && u.cells.some(c => (c % 20) === attackX);
            });

            if (!hasLineOfSight) return socket.emit('systemMsg', "저격 실패: 해당 사선(X열)에 아군 저격수(I)가 없습니다!");

            // 아군 탱커(T) 오사 방지 (최신 좌표 기준)
            const isBlockedByAlly = attacker.units.some(u => {
                if (u.type !== 'T') return false;
                const isAlive = u.cells.length > (u.hitCells ? u.hitCells.length : 0);
                return isAlive && u.cells.some(c => (c % 20) === attackX);
            });

            if (isBlockedByAlly) return socket.emit('systemMsg', "저격 실패: 아군 ㅜ(T) 블럭에 시야가 가려져 있습니다.");
            
            attacker.fuel -= 1; 
            socket.emit('updateFuel', { current: attacker.fuel, max: attacker.maxFuel });
        }

        let hitResult = false;
        let hitType = null;
        let shieldBlocked = false;

        // 🛡️ 상대방 탱커(T) 보호막 판정 (180도 회전 시 상대 전면부는 Y값이 큰 쪽)
        opponent.units.forEach(u => {
            if (u.type === 'T') {
                const isAlive = u.cells.length > (u.hitCells ? u.hitCells.length : 0);
                if (isAlive) {
                    const tXs = u.cells.map(c => c % 20);
                    const tYs = u.cells.map(c => Math.floor(c / 20));
                    const frontY = Math.max(...tYs); // 상대 기준 전면부

                    // 같은 X열이면서 전면부보다 뒤쪽(Y가 작은 쪽)을 쐈을 때 차단
                    if (tXs.includes(targetX) && targetY < frontY && !u.cells.includes(targetIndex)) {
                        shieldBlocked = true;
                    }
                }
            }
        });

        if (shieldBlocked) {
            socket.emit('systemMsg', "🛡️ 상대의 ㅜ(T) 블럭 장갑 보호 영역에 가로막혔습니다!");
        } else {
            opponent.units.forEach(unit => {
                if (unit.cells.includes(targetIndex)) {
                    if (!unit.hitCells) unit.hitCells = [];
                    if (!unit.hitCells.includes(targetIndex)) {
                        unit.hitCells.push(targetIndex);
                        unit.isHit = true;
                    }
                    hitResult = true;
                    hitType = unit.type;

                    if (unit.type === 'ㄷ' && unit.hitCells.length === unit.cells.length) {
                        opponent.maxFuel = Math.max(0, opponent.maxFuel - 2);
                        attacker.maxFuel += 1;
                        io.to(currentRoom).emit('systemMsg', "⚠️ 제조창(ㄷ) 완전 파괴! 연료 시스템 타격!");
                    }
                    if (unit.type === '📦') {
                        opponent.fuel += 2;
                        io.to(opponent.id).emit('updateFuel', { current: opponent.fuel, max: opponent.maxFuel });
                    }
                }
            });
        }

        // 결과 통보 및 턴 전환
        if (hitResult) {
            const allDestroyed = opponent.units.every(u => u.type === '📦' || u.cells.length === (u.hitCells ? u.hitCells.length : 0));
            if (allDestroyed) {
                io.to(currentRoom).emit('attackResult', { attacker: socket.id, attackIndex, targetIndex, hit: true });
                room.gameState = 'ENDED';
                io.to(currentRoom).emit('gameOver', { winner: userName });
            } else if (hitType === 'T') {
                io.to(currentRoom).emit('systemMsg', "🛡️ ㅜ(T) 블럭 타격: 추가 공격 기회 소멸!");
                passTurn(room, opponent.id);
                io.to(currentRoom).emit('attackResult', { attacker: socket.id, attackIndex, targetIndex, hit: true, nextTurn: opponent.id });
            } else {
                io.to(currentRoom).emit('attackResult', { attacker: socket.id, attackIndex, targetIndex, hit: true });
            }
        } else {
            room.phraseCount++;
            io.to(currentRoom).emit('attackResult', { attacker: socket.id, attackIndex, targetIndex, hit: false, blocked: shieldBlocked, nextTurn: opponent.id });
            passTurn(room, opponent.id);
            if (room.phraseCount > 0 && room.phraseCount % 5 === 0) {
                room.gameState = 'MOVING';
                io.to(currentRoom).emit('startMoving');
            }
        }
    });

    // 9. 기동함선(1x1) 이동 엔진 (🚨 대면 모드 레이더 업그레이드)
    socket.on('move1x1', (data) => {
        const room = rooms[currentRoom];
        if (!room || room.gameState !== 'PLAYING' || room.turn !== socket.id) return;
        
        const { from, to } = data;
        const player = room.players.find(p => p.id === socket.id);
        const opponent = room.players.find(p => p.id !== socket.id);
        
        if (player.fuel < 2) return socket.emit('systemMsg', "기동 실패: 연료가 2 필요합니다.");

        const fromX = from % 20, fromY = Math.floor(from / 20);
        const toX = to % 20, toY = Math.floor(to / 20);
        if (Math.abs(fromX - toX) > 1 || Math.abs(fromY - toY) > 1) {
            return socket.emit('systemMsg', "기동 실패: 인접한 1칸(대각선 포함 8방향)으로만 이동 가능합니다.");
        }

        const unit = player.units.find(u => u.type === '1x1' && u.cells.includes(from) && !u.isHit);
        if (!unit) return;

        unit.cells = [to];
        player.fuel -= 2;
        socket.emit('updateFuel', { current: player.fuel, max: player.maxFuel });
        socket.emit('syncMovedUnit', { oldIdx: from, newIdx: to }); 
        socket.emit('systemMsg', "🏃 1x1 기동함선 이동 완료. (-2⛽)");

        // 📡 레이더(L) 발각 판정 (내 toX는 상대방 입장에서는 19 - toX 열에 해당함!)
        const isSpotted = opponent.units.some(u => {
            if (u.type !== 'L') return false;
            const isAlive = u.cells.length > (u.hitCells ? u.hitCells.length : 0);
            return isAlive && u.cells.some(c => c % 20 === (19 - toX));
        });

        if (isSpotted) {
            io.to(currentRoom).emit('systemMsg', "📡 [레이더 경보] 적 기동함선의 움직임이 포착되었습니다!");
        }
    });

    // 7. 게임 종료 및 로비 초기화 로직
    socket.on('requestRematch', () => {
        const room = rooms[currentRoom];
        if (!room || room.gameState !== 'ENDED') return;

        room.gameState = 'LOBBY';
        room.phraseCount = 0;
        room.turn = null;

        room.players.forEach(p => {
            room.spectators.push({ id: p.id, name: p.name });
        });
        
        room.players = [];

        io.to(currentRoom).emit('rematchStarted');
        updateRoomInfo(currentRoom);
        io.to(currentRoom).emit('systemMsg', "방이 초기화되었습니다. 다시 게임을 하려면 [플레이어로 가기]를 눌러주세요!");
    });

    socket.on('sendChat', (msg) => {
        if (currentRoom) io.to(currentRoom).emit('receiveChat', { name: userName, msg });
    });

    // 8. 접속 종료 로직
    socket.on('disconnect', () => {
        if (currentRoom && rooms[currentRoom]) {
            const room = rooms[currentRoom];
            const wasPlayer = room.players.some(p => p.id === socket.id);
            
            room.players = room.players.filter(p => p.id !== socket.id);
            room.spectators = room.spectators.filter(s => s.id !== socket.id);
            
            if (wasPlayer && (room.gameState === 'PLAYING' || room.gameState === 'PLACING' || room.gameState === 'MOVING')) {
                room.gameState = 'LOBBY';
                room.phraseCount = 0;
                room.turn = null;
                room.players.forEach(p => { 
                    p.isReady = false; 
                    p.placed = false; 
                    p.units = []; 
                });
                
                io.to(currentRoom).emit('systemMsg', "🚨 상대방의 연결이 끊겨 게임이 로비로 초기화되었습니다.");
                io.to(currentRoom).emit('rematchStarted'); 
            }
            
            updateRoomInfo(currentRoom);
        }
    });

    // 🚨 턴 넘기기 유틸 함수 (연료 마이너스 통장 탈출 공식 적용!)
    function passTurn(room, nextTurnId) {
        room.turn = nextTurnId;
        const nextPlayer = room.players.find(p => p.id === nextTurnId);
        if (nextPlayer) {
            const aliveShips = nextPlayer.units.filter(u => u.type !== '📦' && u.cells.length > (u.hitCells ? u.hitCells.length : 0)).length;
            
            // 🚨 매 턴마다 [최대 연료 - 생존 함선 수] 공식으로 리필!
            nextPlayer.fuel = nextPlayer.maxFuel - aliveShips; 
            if (nextPlayer.fuel < 0) nextPlayer.fuel = 0; 
            
            io.to(nextTurnId).emit('updateFuel', { current: nextPlayer.fuel, max: nextPlayer.maxFuel });
            io.to(nextTurnId).emit('systemMsg', `🔥 내 턴 시작! (유지비 차감 후 연료: ⛽ ${nextPlayer.fuel})`);
        }
    }

    function updateRoomInfo(roomCode) {
        if (rooms[roomCode]) {
            io.to(roomCode).emit('roomData', rooms[roomCode]);
        }
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Tactical Engine Active on port ${PORT}`));
