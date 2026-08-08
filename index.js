const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Heslo nastavené natvrdo (ignoruje nastavení z Renderu)
const ADMIN_PASSWORD = 'aaaaaa';

// Připojení k PostgreSQL databázi na Renderu
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Pomocná funkce pro zápis do logů
async function logEvent(category, text) {
  try {
    await pool.query(
      'INSERT INTO game_logs (category, text, created_at) VALUES ($1, $2, NOW())',
      [category, text]
    );
  } catch (err) {
    console.error('Chyba při zápisu do logu:', err);
  }
}

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

    await pool.query(`
      CREATE TABLE IF NOT EXISTS game_logs (
        id SERIAL PRIMARY KEY,
        category VARCHAR(20) NOT NULL,
        text TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    const wordsCount = await pool.query('SELECT COUNT(*) FROM impostor_words');
    if (parseInt(wordsCount.rows[0].count) === 0) {
      await pool.query(`
        INSERT INTO impostor_words (word) VALUES 
        ('Káva'), ('Letiště'), ('Nemocnice'), ('Škola'), ('Fotbal');
      `);
    }

    const todCount = await pool.query('SELECT COUNT(*) FROM truth_or_dare');
    if (parseInt(todCount.rows[0].count) === 0) {
      await pool.query(`
        INSERT INTO truth_or_dare (type, text) VALUES 
        ('truth', 'Jaké je tvoje největší tajemství?'),
        ('dare', 'Udělej 10 kliků přímo teď.');
      `);
    }

    console.log('SQL DB inicializována.');
    await logEvent('GAMES', 'Server byl úspěšně spuštěn.');
  } catch (err) {
    console.error('Chyba při inicializaci SQL DB:', err);
  }
}

initDb();

// Automatické mazání logů starších než 12 hodin
setInterval(async () => {
  try {
    const res = await pool.query("DELETE FROM game_logs WHERE created_at < NOW() - INTERVAL '12 hours'");
    if (res.rowCount > 0) {
      console.log(`Smazáno ${res.rowCount} starých logů.`);
    }
  } catch (err) {
    console.error('Chyba při mazání starých logů:', err);
  }
}, 60 * 60 * 1000);

// Middleware pro kontrolu hesla
function checkAdminAuth(req, res, next) {
  const authHeader = req.headers['x-admin-password'] || req.query.password || req.body.password;
  if (authHeader === ADMIN_PASSWORD) {
    next();
  } else {
    res.status(401).json({ error: 'Neplatné heslo' });
  }
}

// ==========================================
// TAJNÝ REŽISÉRSKÝ PANEL API
// ==========================================

let riggedQuestions = {}; // Ukládá podvržené otázky pro místnosti

app.get('/api/hidden/info', checkAdminAuth, (req, res) => {
  const roomsInfo = {};
  for (const code in rooms) {
    const room = rooms[code];
    const activePlayer = (room.currentGame === 'truth_or_dare' && room.todPlayerOrder && room.todPlayerOrder.length > 0) 
      ? room.todPlayerOrder[room.currentTurnIndex]?.name 
      : 'Nikdo';

    roomsInfo[code] = {
      players: room.players.map(p => p.name),
      activePlayer: activePlayer,
      rigged: riggedQuestions[code] || null
    };
  }
  res.json({ rooms: roomsInfo });
});

app.post('/api/hidden/rig', checkAdminAuth, (req, res) => {
  const { roomCode, customText, type } = req.body;
  if (!roomCode || !customText) return res.status(400).send('Chybí data');

  riggedQuestions[roomCode] = {
    type: type || 'dare',
    text: customText
  };

  logEvent('TOD', `🕵️ SKRYTÝ PODVRH: Pro místnost ${roomCode} připraven úkol/otázka: "${customText}"`);
  res.json({ success: true });
});

// ==========================================
// ADMIN API ENDPOINTY (/admin)
// ==========================================

app.get('/api/admin/data', checkAdminAuth, async (req, res) => {
  try {
    const words = await pool.query('SELECT * FROM impostor_words ORDER BY id DESC');
    const tod = await pool.query('SELECT * FROM truth_or_dare ORDER BY id DESC');
    const logs = await pool.query('SELECT *, TO_CHAR(created_at, \'HH24:MI:SS\') as time_str FROM game_logs ORDER BY id DESC LIMIT 150');
    res.json({ words: words.rows, tod: tod.rows, logs: logs.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/impostor', checkAdminAuth, async (req, res) => {
  const { wordsInput } = req.body;
  if (!wordsInput) return res.status(400).send('Chybí data');

  const items = wordsInput.split(';').map(s => s.trim()).filter(s => s.length > 0);
  try {
    for (const word of items) {
      await pool.query('INSERT INTO impostor_words (word) VALUES ($1) ON CONFLICT DO NOTHING', [word]);
    }
    await logEvent('GAMES', `Přidána slova do Impostora: ${items.join(', ')}`);
    res.json({ success: true, count: items.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/tod', checkAdminAuth, async (req, res) => {
  const { type, textInput } = req.body;
  if (!type || !textInput) return res.status(400).send('Chybí data');

  const items = textInput.split(';').map(s => s.trim()).filter(s => s.length > 0);
  try {
    for (const text of items) {
      await pool.query('INSERT INTO truth_or_dare (type, text) VALUES ($1, $2)', [type, text]);
    }
    await logEvent('TOD', `Přidány nové otázky/úkoly (${type}): ${items.length} ks`);
    res.json({ success: true, count: items.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/:table/:id', checkAdminAuth, async (req, res) => {
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

app.post('/api/admin/clear-logs', checkAdminAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM game_logs');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// HTML Administrátorská Stránka (/admin)
app.get('/admin', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="cs">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Párty Hra - Administrace</title>
      <style>
        * { box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 15px; }
        .container { max-width: 900px; margin: 0 auto; }
        h1 { color: #38bdf8; text-align: center; font-size: 24px; margin-bottom: 20px; }
        .card { background: #1e293b; padding: 20px; border-radius: 12px; margin-bottom: 20px; box-shadow: 0 4px 6px rgba(0,0,0,0.3); }
        h2 { color: #4ade80; font-size: 18px; margin-top: 0; border-bottom: 1px solid #334155; padding-bottom: 8px; display: flex; justify-content: space-between; align-items: center; }
        input, select, textarea, button { font-size: 16px; padding: 12px; border-radius: 8px; border: 1px solid #334155; background: #0f172a; color: white; width: 100%; margin-bottom: 10px; }
        button { background: #38bdf8; color: #0f172a; font-weight: bold; border: none; cursor: pointer; transition: 0.2s; }
        button:hover { background: #0284c7; color: white; }
        .hint { font-size: 13px; color: #94a3b8; margin-top: -5px; margin-bottom: 10px; }
        #authOverlay { position: fixed; top:0; left:0; width:100%; height:100%; background: #0f172a; display: flex; justify-content: center; align-items: center; z-index: 999; }
        .login-box { background: #1e293b; padding: 30px; border-radius: 12px; width: 90%; max-width: 400px; text-align: center; }
        .list-box { max-height: 250px; overflow-y: auto; margin-top: 10px; }
        .list-item { display: flex; justify-content: space-between; align-items: center; background: #0f172a; padding: 10px 14px; border-radius: 8px; margin-bottom: 8px; border: 1px solid #334155; font-size: 14px; word-break: break-word; }
        .btn-del { background: #ef4444; color: white; border: none; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 12px; width: auto; margin-left: 10px; flex-shrink: 0; margin-bottom: 0; }
        .badge { font-weight: bold; padding: 2px 8px; border-radius: 4px; font-size: 11px; margin-right: 8px; text-transform: uppercase; }
        .badge-truth { background: #3b82f6; color: white; }
        .badge-dare { background: #a855f7; color: white; }
        .log-tabs { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
        .tab-btn { background: #334155; color: white; border: none; padding: 8px 14px; border-radius: 6px; font-size: 13px; cursor: pointer; width: auto; margin-bottom: 0; }
        .tab-btn.active { background: #38bdf8; color: #0f172a; font-weight: bold; }
        .log-item { padding: 8px 12px; border-bottom: 1px solid #334155; font-size: 13px; display: flex; gap: 10px; }
        .log-time { color: #64748b; font-family: monospace; }
        .log-cat { font-weight: bold; color: #38bdf8; width: 80px; flex-shrink: 0; }
      </style>
    </head>
    <body>

      <div id="authOverlay">
        <div class="login-box">
          <h2 style="justify-content: center; color: #38bdf8;">🔒 Administrace</h2>
          <p style="color: #94a3b8; font-size: 14px;">Zadejte heslo pro přístup</p>
          <input type="password" id="passInput" value="aaaaaa" placeholder="Heslo admina" onkeydown="if(event.key==='Enter') login()">
          <button onclick="login()">Vstoupit</button>
          <div id="loginError" style="color: #ef4444; margin-top: 10px; font-size: 14px; display: none;">Neplatné heslo!</div>
        </div>
      </div>

      <div class="container" id="mainContent" style="display: none;">
        <h1>⚙️ Správa Databáze & Logy</h1>

        <div class="card">
          <h2>
            📜 Logy Hry (Mazáno po 12 hod)
            <div>
              <button onclick="downloadLogsTxt()" style="background: #059669; width: auto; font-size: 12px; padding: 6px 12px; margin-bottom:0; margin-right: 5px;">📥 Stáhnout (.txt)</button>
              <button onclick="clearLogs()" style="background: #475569; width: auto; font-size: 12px; padding: 6px 12px; margin-bottom:0;">Smazat Logy</button>
            </div>
          </h2>
          <div class="log-tabs">
            <button class="tab-btn active" onclick="filterLogs('ALL', this)">Vše</button>
            <button class="tab-btn" onclick="filterLogs('PLAYERS', this)">Hráči</button>
            <button class="tab-btn" onclick="filterLogs('GAMES', this)">Hry</button>
            <button class="tab-btn" onclick="filterLogs('IMPOSTOR', this)">Impostor</button>
            <button class="tab-btn" onclick="filterLogs('TOD', this)">Pravda / Úkol</button>
          </div>
          <div id="logsBox" class="list-box" style="max-height: 300px; background: #0f172a; border-radius: 8px; padding: 8px;">
            <i>Načítám logy...</i>
          </div>
        </div>

        <div class="card">
          <h2>🕵️ Přidat slova pro Impostora</h2>
          <textarea id="impInput" placeholder="Káva; Letiště; Kino; Restaurace; Aquapark" rows="2"></textarea>
          <div class="hint">Můžete vložit více slov najednou – stačí je oddělit středníkem (<b>;</b>).</div>
          <button onclick="addImpostorWords()">➕ Přidat Slova</button>
          <div id="impostorList" class="list-box"><i>Načítám...</i></div>
        </div>

        <div class="card">
          <h2>🎲 Přidat Pravdu nebo Úkol</h2>
          <select id="todType">
            <option value="truth">Pravda</option>
            <option value="dare">Úkol</option>
          </select>
          <textarea id="todInput" placeholder="První otázka... ; Druhá otázka... ; Třetí otázka..." rows="2"></textarea>
          <div class="hint">Více otázek/úkolů najednou oddělujte středníkem (<b>;</b>).</div>
          <button onclick="addTodQuestions()" style="background: #a855f7; color: white;">➕ Přidat Otázky/Úkoly</button>
          <div id="todList" class="list-box"><i>Načítám...</i></div>
        </div>
      </div>

      <script>
        let adminPassword = 'aaaaaa';
        let allLogs = [];
        let currentFilter = 'ALL';

        async function login() {
          const p = document.getElementById('passInput').value;
          adminPassword = p || 'aaaaaa';
          const success = await loadData();
          if (success) {
            localStorage.setItem('admin_pass', adminPassword);
            document.getElementById('authOverlay').style.display = 'none';
            document.getElementById('mainContent').style.display = 'block';
          } else {
            document.getElementById('loginError').style.display = 'block';
          }
        }

        async function loadData() {
          try {
            const res = await fetch('/api/admin/data', {
              headers: { 'x-admin-password': adminPassword }
            });
            if (res.status === 401) return false;

            const data = await res.json();
            allLogs = data.logs;

            renderLogs();
            renderWords(data.words);
            renderTod(data.tod);
            return true;
          } catch (e) {
            return false;
          }
        }

        function filterLogs(cat, btn) {
          currentFilter = cat;
          document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          renderLogs();
        }

        function renderLogs() {
          const box = document.getElementById('logsBox');
          const filtered = currentFilter === 'ALL' ? allLogs : allLogs.filter(l => l.category === currentFilter);
          
          if (filtered.length === 0) {
            box.innerHTML = '<div style="color: #64748b; padding: 10px;">Žádné logy v této kategorii.</div>';
            return;
          }

          box.innerHTML = filtered.map(l => \`
            <div class="log-item">
              <span class="log-time">\${l.time_str}</span>
              <span class="log-cat">\${l.category}</span>
              <span>\${l.text}</span>
            </div>
          \`).join('');
        }

        function downloadLogsTxt() {
          const filtered = currentFilter === 'ALL' ? allLogs : allLogs.filter(l => l.category === currentFilter);
          if (filtered.length === 0) {
            alert('Žádné logy ke stažení!');
            return;
          }

          let txtContent = \`=== PÁRTY HRA - HERNÍ LOGY (\${currentFilter}) ===\\n\`;
          txtContent += \`Vygenerováno: \${new Date().toLocaleString('cs-CZ')}\\n\`;
          txtContent += \`==================================================\\n\\n\`;

          filtered.forEach(l => {
            txtContent += \`[\${l.time_str}] [\${l.category}] \${l.text}\\n\`;
          });

          const blob = new Blob([txtContent], { type: 'text/plain;charset=utf-8;' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          const dateStr = new Date().toISOString().slice(0, 10);
          a.href = url;
          a.download = \`herni_logy_\${currentFilter.toLowerCase()}_\${dateStr}.txt\`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }

        function renderWords(words) {
          const box = document.getElementById('impostorList');
          if (words.length === 0) {
            box.innerHTML = '<p style="color: #64748b;">Žádná slova v databázi.</p>';
            return;
          }
          box.innerHTML = words.map(w => \`
            <div class="list-item">
              <span>\${w.word}</span>
              <button class="btn-del" onclick="deleteItem('impostor_words', \${w.id})">Smazat</button>
            </div>
          \`).join('');
        }

        function renderTod(tod) {
          const box = document.getElementById('todList');
          if (tod.length === 0) {
            box.innerHTML = '<p style="color: #64748b;">Žádné otázky v databázi.</p>';
            return;
          }
          box.innerHTML = tod.map(t => \`
            <div class="list-item">
              <div>
                <span class="badge \${t.type === 'truth' ? 'badge-truth' : 'badge-dare'}">\${t.type}</span>
                <span>\${t.text}</span>
              </div>
              <button class="btn-del" onclick="deleteItem('truth_or_dare', \${t.id})">Smazat</button>
            </div>
          \`).join('');
        }

        async function addImpostorWords() {
          const val = document.getElementById('impInput').value;
          if (!val) return;
          await fetch('/api/admin/impostor', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-admin-password': adminPassword },
            body: JSON.stringify({ wordsInput: val })
          });
          document.getElementById('impInput').value = '';
          loadData();
        }

        async function addTodQuestions() {
          const type = document.getElementById('todType').value;
          const val = document.getElementById('todInput').value;
          if (!val) return;
          await fetch('/api/admin/tod', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-admin-password': adminPassword },
            body: JSON.stringify({ type, textInput: val })
          });
          document.getElementById('todInput').value = '';
          loadData();
        }

        async function deleteItem(table, id) {
          if (confirm('Opravdu smazat?')) {
            await fetch(\`/api/admin/\${table}/\${id}\`, {
              method: 'DELETE',
              headers: { 'x-admin-password': adminPassword }
            });
            loadData();
          }
        }

        async function clearLogs() {
          if (confirm('Opravdu vymazat všechny logy?')) {
            await fetch('/api/admin/clear-logs', {
              method: 'POST',
              headers: { 'x-admin-password': adminPassword }
            });
            loadData();
          }
        }

        login();
      </script>
    </body>
    </html>
  `);
});

// ==========================================
// SOCKET.IO LOBBY A LOGIKA HRY
// ==========================================

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const rooms = {};

io.on('connection', (socket) => {

  socket.on('create_room', () => {
    const roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
    rooms[roomCode] = { 
      hostId: socket.id, 
      players: [], 
      currentGame: null, 
      currentTurnIndex: 0,
      roundCount: 1,
      secretWord: '',
      impostorCount: 1,
      votes: {},
      todPlayerOrder: []
    };
    socket.join(roomCode);
    socket.emit('room_created', { roomCode });
    logEvent('GAMES', `Vytvořena nová herní místnost: ${roomCode}`);
  });

  socket.on('join_room', ({ roomCode, playerName }) => {
    const room = rooms[roomCode];
    if (!room) return socket.emit('error_msg', 'Místnost neexistuje!');

    const trimmedName = playerName.trim();
    const existingPlayer = room.players.find(p => p.name.toLowerCase() === trimmedName.toLowerCase());

    if (existingPlayer) {
      existingPlayer.id = socket.id;
      socket.join(roomCode);

      socket.emit('joined_successfully', { playerName: existingPlayer.name, roomCode });
      logEvent('PLAYERS', `Hráč "${existingPlayer.name}" obnovil stránku v ${roomCode}`);

      if (room.currentGame === 'impostor') {
        socket.emit('assign_role', { 
          game: 'impostor', 
          role: existingPlayer.role, 
          word: existingPlayer.role === 'Impostor' ? '???' : room.secretWord 
        });
        sendImpostorTurnState(roomCode);
      } else if (room.currentGame === 'truth_or_dare') {
        sendTodTurnState(roomCode);
      }
    } else {
      const newPlayer = { id: socket.id, name: trimmedName, role: 'Hráč' };
      room.players.push(newPlayer);
      socket.join(roomCode);

      socket.emit('joined_successfully', { playerName: trimmedName, roomCode });
      io.to(room.hostId).emit('update_players', room.players);

      logEvent('PLAYERS', `Hráč "${trimmedName}" se připojil do místnosti ${roomCode}`);
    }
  });

  // LOGIKA IMPOSTOR
  socket.on('start_impostor', async ({ roomCode, impostorCount }) => {
    const room = rooms[roomCode];
    if (!room || room.players.length === 0) return;

    room.currentGame = 'impostor';
    room.impostorCount = Math.min(parseInt(impostorCount) || 1, room.players.length - 1 || 1);
    room.currentTurnIndex = 0;
    room.roundCount = 1;
    room.votes = {};

    try {
      const dbRes = await pool.query('SELECT word FROM impostor_words ORDER BY RANDOM() LIMIT 1');
      room.secretWord = dbRes.rows[0]?.word || 'Káva';

      const shuffledIndices = room.players.map((_, i) => i).sort(() => Math.random() - 0.5);
      const impostorIndices = shuffledIndices.slice(0, room.impostorCount);

      const impostorNames = [];
      room.players.forEach((player, index) => {
        if (impostorIndices.includes(index)) {
          player.role = 'Impostor';
          impostorNames.push(player.name);
        } else {
          player.role = 'Hráč';
        }
      });

      const allowImpostorToStart = Math.random() < 0.1; 
      let startIndex = 0;

      if (!allowImpostorToStart) {
        const regularPlayerIndices = room.players
          .map((p, idx) => p.role === 'Hráč' ? idx : -1)
          .filter(idx => idx !== -1);
        if (regularPlayerIndices.length > 0) {
          startIndex = regularPlayerIndices[Math.floor(Math.random() * regularPlayerIndices.length)];
        }
      } else {
        startIndex = Math.floor(Math.random() * room.players.length);
      }

      room.currentTurnIndex = startIndex;

      room.players.forEach((player) => {
        io.to(player.id).emit('assign_role', { 
          game: 'impostor', 
          role: player.role, 
          word: player.role === 'Impostor' ? '???' : room.secretWord 
        });
      });

      sendImpostorTurnState(roomCode);
      logEvent('IMPOSTOR', `Spuštěna hra v ${roomCode}. Tajné slovo: "${room.secretWord}", Impostoři: ${impostorNames.join(', ')}. Začíná: ${room.players[startIndex].name}`);
    } catch (err) {
      console.error('Chyba DB:', err);
    }
  });

  socket.on('next_impostor_turn', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.players.length === 0) return;

    room.currentTurnIndex = (room.currentTurnIndex + 1) % room.players.length;
    if (room.currentTurnIndex === 0) {
      room.roundCount++;
    }
    sendImpostorTurnState(roomCode);
  });

  socket.on('start_voting', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;

    room.votes = {};
    const playerList = room.players.map(p => ({ id: p.id, name: p.name }));
    io.to(roomCode).emit('impostor_voting_started', { players: playerList });
    logEvent('IMPOSTOR', `Spuštěno hlasování v místnosti ${roomCode}`);
  });

  socket.on('submit_vote', ({ roomCode, votedPlayerId }) => {
    const room = rooms[roomCode];
    if (!room) return;

    room.votes[socket.id] = votedPlayerId;

    const voteCounts = {};
    Object.values(room.votes).forEach(targetId => {
      voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
    });

    io.to(room.hostId).emit('update_vote_counts', {
      totalVotes: Object.keys(room.votes).length,
      totalPlayers: room.players.length,
      voteCounts: voteCounts
    });
  });

  socket.on('reveal_impostor', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;

    const impostors = room.players.filter(p => p.role === 'Impostor').map(p => p.name);
    io.to(roomCode).emit('impostor_revealed', {
      impostors: impostors,
      secretWord: room.secretWord
    });
    logEvent('IMPOSTOR', `Konec hry v ${roomCode}. Odhaleni Impostoři: ${impostors.join(', ')}`);
  });

  // LOGIKA PRAVDA NEBO ÚKOL (I S KONTROLU PODVRŽENÝCH ÚKOLŮ)
  socket.on('start_truth_or_dare', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.players.length === 0) return;

    room.currentGame = 'truth_or_dare';
    room.todPlayerOrder = [...room.players].sort(() => Math.random() - 0.5);
    room.currentTurnIndex = 0;

    io.to(room.hostId).emit('game_started', { game: 'Pravda nebo Úkol' });
    logEvent('TOD', `Spuštěna hra Pravda nebo Úkol v místnosti ${roomCode}`);
    
    sendTodTurnState(roomCode);
  });

  socket.on('tod_choice', async ({ roomCode, choice }) => {
    const room = rooms[roomCode];
    if (!room || room.todPlayerOrder.length === 0) return;

    const activePlayer = room.todPlayerOrder[room.currentTurnIndex];
    let question = '';
    let choiceLabel = choice === 'truth' ? 'PRAVDA' : 'ÚKOL';

    // KONTROLA: Zda je pro tuto místnost nastaven podvržený úkol z /hidden!
    if (riggedQuestions[roomCode]) {
      question = riggedQuestions[roomCode].text;
      choiceLabel = riggedQuestions[roomCode].type === 'truth' ? 'PRAVDA' : 'ÚKOL';
      delete riggedQuestions[roomCode]; // Po použití podvrh smažeme
      console.log('😈 PODVRŽENÝ ÚKOL POUŽIT!');
    } else {
      try {
        const dbRes = await pool.query(
          'SELECT text FROM truth_or_dare WHERE type = $1 ORDER BY RANDOM() LIMIT 1', 
          [choice]
        );
        question = dbRes.rows[0]?.text || 'Chyba načtení otázky';
      } catch (err) {
        console.error('Chyba DB:', err);
      }
    }

    io.to(roomCode).emit('tod_question', {
      playerName: activePlayer.name,
      type: choiceLabel,
      text: question
    });

    logEvent('TOD', `Hráč "${activePlayer.name}" si vybral [${choiceLabel}]: "${question}"`);
  });

  socket.on('next_tod_turn', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.todPlayerOrder.length === 0) return;

    room.currentTurnIndex = (room.currentTurnIndex + 1) % room.todPlayerOrder.length;
    sendTodTurnState(roomCode);
  });

  socket.on('return_to_lobby', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;
    room.currentGame = null;
    io.to(roomCode).emit('back_to_lobby');
    logEvent('GAMES', `Návrat do lobby v místnosti ${roomCode}`);
  });

  socket.on('disconnect', () => {
    for (const code in rooms) {
      const room = rooms[code];
      const playerIndex = room.players.findIndex(p => p.id === socket.id);
      
      if (playerIndex !== -1) {
        const disconnectedPlayer = room.players[playerIndex];

        setTimeout(() => {
          if (disconnectedPlayer.id === socket.id) {
            room.players.splice(playerIndex, 1);
            
            if (room.todPlayerOrder) {
              room.todPlayerOrder = room.todPlayerOrder.filter(p => p.name !== disconnectedPlayer.name);
            }

            io.to(room.hostId).emit('update_players', room.players);
            logEvent('PLAYERS', `Hráč "${disconnectedPlayer.name}" se odpojil z ${code}`);
          }
        }, 4000);
        break;
      }
    }
  });
});

function sendImpostorTurnState(roomCode) {
  const room = rooms[roomCode];
  if (!room || room.players.length === 0) return;

  const activePlayer = room.players[room.currentTurnIndex];
  const nextPlayer = room.players[(room.currentTurnIndex + 1) % room.players.length];

  io.to(roomCode).emit('impostor_turn_update', {
    activePlayerId: activePlayer.id,
    activePlayerName: activePlayer.name,
    nextPlayerName: nextPlayer.name,
    roundCount: room.roundCount
  });
}

function sendTodTurnState(roomCode) {
  const room = rooms[roomCode];
  if (!room || room.todPlayerOrder.length === 0) return;

  const activePlayer = room.todPlayerOrder[room.currentTurnIndex];
  
  io.to(roomCode).emit('tod_player_turn', { 
    playerId: activePlayer.id, 
    playerName: activePlayer.name 
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server běží na portu ${PORT}`));
