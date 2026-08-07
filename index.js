const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());

// Připojení k PostgreSQL (Render si adresu vezme z prostředíDATABASE_URL)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Založení tabulek a vložení testovacích dat do SQL
async function initDb() {
  try {
    // Tabulka pro Impostor slova
    await pool.query(`
      CREATE TABLE IF NOT EXISTS impostor_words (
        id SERIAL PRIMARY KEY,
        word VARCHAR(100) NOT NULL
      );
    `);

    // Tabulka pro Pravda nebo Úkol
    await pool.query(`
      CREATE TABLE IF NOT EXISTS truth_or_dare (
        id SERIAL PRIMARY KEY,
        type VARCHAR(10) NOT NULL, -- 'truth' nebo 'dare'
        text TEXT NOT NULL
      );
    `);

    // Zkontrolujeme, zda jsou tabulky prázdné – pokud ano, vložíme základní data
    const wordsCount = await pool.query('SELECT COUNT(*) FROM impostor_words');
    if (parseInt(wordsCount.rows[0].count) === 0) {
      await pool.query(`
        INSERT INTO impostor_words (word) VALUES 
        ('Káva'), ('Letiště'), ('Nemocnice'), ('Škola'), ('Fotbal'), 
        ('Pláž'), ('Kino'), ('Restaurace'), ('Vlak'), ('Supermarket');
      `);
      console.log('SQL: Vložena výchozí slova pro Impostora.');
    }

    const todCount = await pool.query('SELECT COUNT(*) FROM truth_or_dare');
    if (parseInt(todCount.rows[0].count) === 0) {
      await pool.query(`
        INSERT INTO truth_or_dare (type, text) VALUES 
        ('truth', 'Jaké je tvoje největší tajemství?'),
        ('truth', 'Co byla tvoje nejhorší schůzka v životě?'),
        ('dare', 'Udělej 10 kliků přímo teď.'),
        ('dare', 'Mluv dalších 3 minuty s cizím přízvukem.');
      `);
      console.log('SQL: Vloženy výchozí otázky pro Pravda/Úkol.');
    }
  } catch (err) {
    console.error('Chyba při inicializaci SQL DB:', err);
  }
}

initDb();

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const rooms = {};

io.on('connection', (socket) => {
  console.log('Připojen:', socket.id);

  socket.on('create_room', () => {
    const roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
    rooms[roomCode] = { hostId: socket.id, players: [], currentGame: null, currentTurnPlayer: null };
    socket.join(roomCode);
    socket.emit('room_created', { roomCode });
  });

  socket.on('join_room', ({ roomCode, playerName }) => {
    const room = rooms[roomCode];
    if (!room) return socket.emit('error_msg', 'Místnost neexistuje!');

    const player = { id: socket.id, name: playerName, role: '' };
    room.players.push(player);
    socket.join(roomCode);

    socket.emit('joined_successfully', { playerName, roomCode });
    io.to(room.hostId).emit('update_players', room.players);
  });

  // Hra IMPOSTOR – Načtení náhodného slova z SQL
  socket.on('start_impostor', async ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.players.length === 0) return;

    try {
      // SQL dotaz pro náhodný výběr jednoho slova z DB
      const dbRes = await pool.query('SELECT word FROM impostor_words ORDER BY RANDOM() LIMIT 1');
      const randomWord = dbRes.rows[0]?.word || 'Káva';

      const impostorIndex = Math.floor(Math.random() * room.players.length);

      room.players.forEach((player, index) => {
        if (index === impostorIndex) {
          player.role = 'Impostor';
          io.to(player.id).emit('assign_role', { game: 'impostor', role: 'Impostor', word: '???' });
        } else {
          player.role = 'Hráč';
          io.to(player.id).emit('assign_role', { game: 'impostor', role: 'Hráč', word: randomWord });
        }
      });

      io.to(room.hostId).emit('game_started', { game: 'Impostor' });
    } catch (err) {
      console.error('Chyba načítání z DB:', err);
    }
  });

  // Hra PRAVDA NEBO ÚKOL
  socket.on('start_truth_or_dare', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.players.length === 0) return;

    room.currentGame = 'truth_or_dare';
    io.to(room.hostId).emit('game_started', { game: 'Pravda nebo Úkol' });
    nextTruthOrDareTurn(roomCode);
  });

  // Výběr Pravda/Úkol – Načtení náhodné otázky z SQL
  socket.on('tod_choice', async ({ roomCode, choice }) => {
    const room = rooms[roomCode];
    if (!room) return;

    try {
      // SQL dotaz pro náhodnou otázku podle typu
      const dbRes = await pool.query(
        'SELECT text FROM truth_or_dare WHERE type = $1 ORDER BY RANDOM() LIMIT 1', 
        [choice]
      );
      const question = dbRes.rows[0]?.text || 'Chyba načtení otázky';

      io.to(roomCode).emit('tod_question', {
        playerName: room.currentTurnPlayer.name,
        type: choice === 'truth' ? 'PRAVDA' : 'ÚKOL',
        text: question
      });
    } catch (err) {
      console.error('Chyba při načítání otázky z DB:', err);
    }
  });

  socket.on('next_tod_turn', ({ roomCode }) => nextTruthOrDareTurn(roomCode));

  socket.on('return_to_lobby', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;
    io.to(roomCode).emit('back_to_lobby');
  });

  socket.on('disconnect', () => {
    for (const code in rooms) {
      const room = rooms[code];
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx !== -1) {
        room.players.splice(idx, 1);
        io.to(room.hostId).emit('update_players', room.players);
        break;
      }
    }
  });
});

function nextTruthOrDareTurn(roomCode) {
  const room = rooms[roomCode];
  if (!room || room.players.length === 0) return;
  const randomPlayer = room.players[Math.floor(Math.random() * room.players.length)];
  room.currentTurnPlayer = randomPlayer;
  io.to(roomCode).emit('tod_player_turn', { playerId: randomPlayer.id, playerName: randomPlayer.name });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server běží na portu ${PORT}`));
