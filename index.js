const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Připojení k PostgreSQL databázi
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Inicializace databáze
async function initDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS impostor_words (
        id SERIAL PRIMARY KEY,
        word VARCHAR(100) NOT NULL UNIQUE
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS truth_or_dare (
        id SERIAL PRIMARY KEY,
        type VARCHAR(10) NOT NULL,
        text TEXT NOT NULL
      );
    `);

    // Vložení výchozích dat, pokud je DB prázdná
    const wordsCount = await pool.query('SELECT COUNT(*) FROM impostor_words');
    if (parseInt(wordsCount.rows[0].count) === 0) {
      await pool.query(`
        INSERT INTO impostor_words (word) VALUES 
        ('Káva'), ('Letiště'), ('Nemocnice'), ('Škola'), ('Fotbal'), 
        ('Pláž'), ('Kino'), ('Restaurace'), ('Vlak'), ('Supermarket');
      `);
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
    }
    console.log('SQL DB inicializována.');
  } catch (err) {
    console.error('Chyba při inicializaci SQL DB:', err);
  }
}

initDb();

// ==========================================
// ADMIN STRÁNKA (/admin) A API PRO DB
// ==========================================

// Získat všechna slova a otázky (pro Admin web)
app.get('/api/admin/data', async (req, res) => {
  try {
    const words = await pool.query('SELECT * FROM impostor_words ORDER BY id DESC');
    const tod = await pool.query('SELECT * FROM truth_or_dare ORDER BY id DESC');
    res.json({ words: words.rows, tod: tod.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Přidat slovo pro Impostora
app.post('/api/admin/impostor', async (req, res) => {
  const { word } = req.body;
  if (!word) return res.status(400).send('Chybí slovo');
  try {
    await pool.query('INSERT INTO impostor_words (word) VALUES ($1) ON CONFLICT DO NOTHING', [word.trim()]);
    res.redirect('/admin');
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// Přidat otázku pro Pravdu nebo Úkol
app.post('/api/admin/tod', async (req, res) => {
  const { type, text } = req.body;
  if (!type || !text) return res.status(400).send('Chybí data');
  try {
    await pool.query('INSERT INTO truth_or_dare (type, text) VALUES ($1, $2)', [type, text.trim()]);
    res.redirect('/admin');
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// Smazat položku
app.delete('/api/admin/:table/:id', async (req, res) => {
  const { table, id } = req.params;
  const validTables = ['impostor_words', 'truth_or_dare'];
  if (!validTables.includes(table)) return res.status(400).send('Neplatná tabulka');
  
  try {
    await pool.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// HTML Administrátorské Rozhraní
app.get('/admin', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="cs">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Párty Hra - Správa Databáze</title>
      <style>
        * { box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 15px; }
        .container { max-width: 800px; margin: 0 auto; }
        h1 { color: #38bdf8; text-align: center; font-size: 24px; }
        .card { background: #1e293b; padding: 20px; border-radius: 12px; margin-bottom: 20px; box-shadow: 0 4px 6px rgba(0,0,0,0.3); }
        h2 { color: #4ade80; font-size: 18px; margin-top: 0; border-bottom: 1px solid #334155; padding-bottom: 8px; }
        form { display: flex; flex-direction: column; gap: 10px; margin-bottom: 15px; }
        input, select, textarea, button { font-size: 16px; padding: 12px; border-radius: 8px; border: 1px solid #334155; background: #0f172a; color: white; width: 100%; }
        button { background: #38bdf8; color: #0f172a; font-weight: bold; border: none; cursor: pointer; transition: 0.2s; }
        button:hover { background: #0284c7; color: white; }
        .list-item { display: flex; justify-content: space-between; align-items: center; background: #0f172a; padding: 10px 14px; border-radius: 8px; margin-bottom: 8px; border: 1px solid #334155; word-break: break-word; }
        .btn-del { background: #ef4444; color: white; border: none; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 14px; width: auto; margin-left: 10px; flex-shrink: 0; }
        .badge { font-weight: bold; padding: 2px 8px; border-radius: 4px; font-size: 12px; margin-right: 8px; text-transform: uppercase; }
        .badge-truth { background: #3b82f6; color: white; }
        .badge-dare { background: #a855f7; color: white; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>⚙️ Správa Databáze Her</h1>

        <!-- FORMULAR PRO IMPOSTORA -->
        <div class="card">
          <h2>🕵️ Přidat slovo pro Impostora</h2>
          <form action="/api/admin/impostor" method="POST">
            <input type="text" name="word" placeholder="Nové slovo (např. Aquapark)" required>
            <button type="submit">➕ Přidat Slovo</button>
          </form>
          <div id="impostorList"><i>Načítám...</i></div>
        </div>

        <!-- FORMULAR PRO PRAVDU NEBO UKOL -->
        <div class="card">
          <h2>🎲 Přidat Pravdu nebo Úkol</h2>
          <form action="/api/admin/tod" method="POST">
            <select name="type">
              <option value="truth">Pravda</option>
              <option value="dare">Úkol</option>
            </select>
            <textarea name="text" placeholder="Text otázky nebo úkolu..." rows="2" required></textarea>
            <button type="submit" style="background: #a855f7; color: white;">➕ Přidat Otázku/Úkol</button>
          </form>
          <div id="todList"><i>Načítám...</i></div>
        </div>
      </div>

      <script>
        async function loadData() {
          const res = await fetch('/api/admin/data');
          const data = await res.json();

          // Vykreslení slov Impostora
          const impList = document.getElementById('impostorList');
          if(data.words.length === 0) {
            impList.innerHTML = '<p style="color: #64748b;">Žádná slova v databázi.</p>';
          } else {
            impList.innerHTML = data.words.map(w => \`
              <div class="list-item">
                <span>\${w.word}</span>
                <button class="btn-del" onclick="deleteItem('impostor_words', \${w.id})">Smazat</button>
              </div>
            \`).join('');
          }

          // Vykreslení Pravdy/Úkolu
          const todList = document.getElementById('todList');
          if(data.tod.length === 0) {
            todList.innerHTML = '<p style="color: #64748b;">Žádné otázky v databázi.</p>';
          } else {
            todList.innerHTML = data.tod.map(t => \`
              <div class="list-item">
                <div>
                  <span class="badge \${t.type === 'truth' ? 'badge-truth' : 'badge-dare'}">\${t.type}</span>
                  <span>\${t.text}</span>
                </div>
                <button class="btn-del" onclick="deleteItem('truth_or_dare', \${t.id})">Smazat</button>
              </div>
            \`).join('');
          }
        }

        async function deleteItem(table, id) {
          if (confirm('Opravdu chcete tuto položku smazat?')) {
            await fetch(\`/api/admin/\${table}/\${id}\`, { method: 'DELETE' });
            loadData();
          }
        }

        loadData();
      </script>
    </body>
    </html>
  `);
});

// ==========================================
// SOCKET.IO LOBBY A HERNÍ LOGIKA
// ==========================================

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const rooms = {};

io.on('connection', (socket) => {
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

  socket.on('start_impostor', async ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.players.length === 0) return;

    try {
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
      console.error('Chyba DB:', err);
    }
  });

  socket.on('start_truth_or_dare', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.players.length === 0) return;

    room.currentGame = 'truth_or_dare';
    io.to(room.hostId).emit('game_started', { game: 'Pravda nebo Úkol' });
    nextTruthOrDareTurn(roomCode);
  });

  socket.on('tod_choice', async ({ roomCode, choice }) => {
    const room = rooms[roomCode];
    if (!room) return;

    try {
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
      console.error('Chyba DB:', err);
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
