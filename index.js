const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

// Ukládání stavu herních místností
const rooms = {};

io.on('connection', (socket) => {
  console.log('Někdo se připojil:', socket.id);

  // 1. Notebook vytvoří novou místnost
  socket.on('create_room', () => {
    const roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
    rooms[roomCode] = { hostId: socket.id, players: [], gameStarted: false };
    
    socket.join(roomCode);
    socket.emit('room_created', { roomCode });
    console.log(`Místnost ${roomCode} vytvořena.`);
  });

  // 2. Hráč na mobilu se připojí do místnosti
  socket.on('join_room', ({ roomCode, playerName }) => {
    const room = rooms[roomCode];

    if (!room) {
      socket.emit('error_msg', 'Místnost neexistuje!');
      return;
    }

    const player = { id: socket.id, name: playerName, role: '' };
    room.players.push(player);
    socket.join(roomCode);

    socket.emit('joined_successfully', { playerName, roomCode });
    
    // Dáme notebooku (hostiteli) vědět, že se připojil nový hráč
    io.to(room.hostId).emit('update_players', room.players);
  });

  // 3. Notebook spustí hru Impostor
  socket.on('start_impostor', ({ roomCode, secretWord }) => {
    const room = rooms[roomCode];
    if (!room || room.players.length === 0) return;

    // Náhodně vybere jednoho Impostora
    const impostorIndex = Math.floor(Math.random() * room.players.length);

    room.players.forEach((player, index) => {
      if (index === impostorIndex) {
        player.role = 'Impostor';
        io.to(player.id).emit('assign_role', { role: 'Impostor', word: '???' });
      } else {
        player.role = 'Hráč';
        io.to(player.id).emit('assign_role', { role: 'Hráč', word: secretWord });
      }
    });

    io.to(room.hostId).emit('game_started', { game: 'Impostor' });
  });

  // Odpojení uživatele
  socket.on('disconnect', () => {
    console.log('Uživatel odpojen:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server běží na portu ${PORT}`);
});

