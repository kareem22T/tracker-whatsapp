const venom = require('venom-bot');
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
const express = require('express');
const app = express();
app.use(express.json());

let activeSessions = {}; // Must be global
let qrCodes = {}; // Must be global

// Database configuration
const dbConfig = {
  host: 'localhost',
  user: 'root',
  password: 'password',
  database: 'whatsapp_tracker'
};

// Create database connection
let db;

// Create media directory if it doesn't exist
const mediaDir = path.join(__dirname, 'media');
if (!fs.existsSync(mediaDir)) {
  fs.mkdirSync(mediaDir, { recursive: true });
}

async function initDatabase() {
  try {
    db = await mysql.createConnection(dbConfig);
    console.log('Database connected successfully');
    
    // Create messages table with media support
    await db.execute(`
        CREATE TABLE IF NOT EXISTS messages (
          id INT AUTO_INCREMENT PRIMARY KEY,
          message_id VARCHAR(255) UNIQUE,
          from_number VARCHAR(50),
          to_number VARCHAR(50),
          message_body TEXT,
          message_type VARCHAR(20),
          is_group BOOLEAN DEFAULT FALSE,
          group_id VARCHAR(100),
          timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          is_from_me BOOLEAN DEFAULT FALSE,
          message_status VARCHAR(20),
          session_name VARCHAR(255),
          media_url VARCHAR(500),
          media_filename VARCHAR(255),
          media_mimetype VARCHAR(100),
          media_size BIGINT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS sessions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        session_name VARCHAR(255) UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    console.log('Messages table ready');
  } catch (error) {
    console.error('Database connection failed:', error);
  }
}

// Function to download and save media
async function downloadMedia(client, message) {
  try {
    const mediaTypes = ['image', 'video', 'audio', 'ptt', 'document', 'sticker'];
    
    if (!mediaTypes.includes(message.type)) {
      return null;
    }

    console.log(`📥 Downloading media for message: ${message.id}`);
    
    // Download media buffer
    const mediaData = await client.decryptFile(message);
    
    if (!mediaData) {
      console.log('❌ Failed to download media');
      return null;
    }

    // Generate filename with proper extension
    const timestamp = Date.now();
    const extension = getFileExtension(message.mimetype || 'application/octet-stream');
    const filename = `${message.type}_${timestamp}_${message.id.split('_')[2] || 'unknown'}${extension}`;
    const filepath = path.join(mediaDir, filename);
    
    // Save media file
    fs.writeFileSync(filepath, mediaData);
    
    console.log(`✅ Media saved: ${filename}`);
    
    return {
      filename: filename,
      filepath: filepath,
      size: mediaData.length,
      mimetype: message.mimetype
    };
    
  } catch (error) {
    console.error('Error downloading media:', error);
    return null;
  }
}

// Helper function to get file extension from mimetype
function getFileExtension(mimetype) {
  const extensions = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'audio/mpeg': '.mp3',
    'audio/ogg': '.ogg',
    'audio/wav': '.wav',
    'audio/aac': '.aac',
    'application/pdf': '.pdf',
    'application/msword': '.doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'text/plain': '.txt'
  };
  
  return extensions[mimetype] || '.bin';
}

// Enhanced function to save message with media support
async function saveMessage(client, message, sessionName) {
  try {
    let mediaInfo = null;
    
    // Check if message contains media
    const mediaTypes = ['image', 'video', 'audio', 'ptt', 'document', 'sticker'];
    if (mediaTypes.includes(message.type)) {
      mediaInfo = await downloadMedia(client, message);
    }
    
    const query = `
          INSERT INTO messages (
            message_id, from_number, to_number, message_body, 
            message_type, is_group, group_id, is_from_me, message_status,
            session_name, media_filename, media_mimetype, media_size
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       `;
    
      const values = [
        message.id,
        message.from,
        message.to,
        message.body || message.caption || (mediaInfo ? `[${message.type.toUpperCase()}]` : ''),
        message.type,
        message.isGroupMsg,
        message.isGroupMsg ? message.from : null,
        message.fromMe,
        'received',
        sessionName, // 🔴 Save session name here
        mediaInfo ? mediaInfo.filename : null,
        mediaInfo ? mediaInfo.mimetype : null,
        mediaInfo ? mediaInfo.size : null
      ];
    
    await db.execute(query, values);
    console.log(`✅ Message saved: ${message.id} ${mediaInfo ? '(with media)' : ''}`);
    
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      console.log('⚠️ Message already exists in database');
    } else {
      console.error('❌ Error saving message:', error);
    }
  }
}

// Function to update message status
async function updateMessageStatus(messageId, status) {
  try {
    await db.execute(
      'UPDATE messages SET message_status = ? WHERE message_id = ?',
      [status, messageId]
    );
    console.log(`📋 Message ${messageId} status updated to: ${status}`);
  } catch (error) {
    console.error('Error updating message status:', error);
  }
}

// Initialize Venom Bot
async function startAgentSession(sessionName) {
  try {
    const client = await venom.create(
      { 
        session: sessionName, 
        headless: 'new', 
        logQR: false, // You will handle QR display
        folderNameToken: 'tokens',
        autoClose: false,
        disableSpins: true,
        disableWelcome: true
      },
      (base64Qr, asciiQR, attempts, urlCode) => {
        console.log(`🆕 QR Code for session ${sessionName} (Attempt ${attempts}):`);
        console.log(asciiQR);

        // Save the latest QR code in memory
        qrCodes[sessionName] = { base64Qr, attempts, urlCode };
      },
      (statusSession, session) => {
        console.log(`Session ${sessionName} status: ${statusSession}`);

        if (statusSession === 'isLogged') {
          console.log(`✅ Session ${sessionName} is now connected`);
          // Remove QR when logged in
          delete qrCodes[sessionName];
        }
      }
    );

    activeSessions[sessionName] = client;
    setupEventListeners(client);

    console.log(`✅ Agent session started: ${sessionName}`);
  } catch (error) {
    console.error(`❌ Failed to start session ${sessionName}:`, error);
  }
}

async function loadAllAgentSessions() {
  try {
    const [sessions] = await db.execute('SELECT session_name FROM sessions');

    if (sessions.length === 0) {
      console.log('⚠️ No sessions found in the database');
      return;
    }

    for (let session of sessions) {
      await startAgentSession(session.session_name);
    }

    console.log('✅ All sessions loaded successfully');
  } catch (error) {
    console.error('❌ Error loading sessions:', error);
  }
}

function setupEventListeners(client) {
  // Listen to ALL messages (sent and received)
  client.onAnyMessage(async (message) => {
    console.log('📱 New message detected:', {
      id: message.id,
      from: message.from,
      body: message.body || message.caption || `[${message.type.toUpperCase()}]`,
      type: message.type,
      fromMe: message.fromMe,
      isGroup: message.isGroupMsg,
      hasMedia: ['image', 'video', 'audio', 'ptt', 'document', 'sticker'].includes(message.type)
    });
    
    // Save to database (now with media support)
    const sessionName = client.session;
    await saveMessage(client, message, sessionName);
  });
  
  // Listen specifically to received messages only
  client.onMessage(async (message) => {
    const messageText = message.body || message.caption || `[${message.type.toUpperCase()}]`;
    console.log('📩 Received message:', messageText);
    
    // Auto-reply example
    if (message.body && message.body.toLowerCase() === 'ping') {
      await client.sendText(message.from, 'pong! 🏓');
    }
    
    // Handle different media types
    switch (message.type) {
      case 'ptt':
        console.log('🎤 Voice message received');
        break;
      case 'image':
        console.log('🖼️ Image received');
        break;
      case 'video':
        console.log('🎥 Video received');
        break;
      case 'audio':
        console.log('🎵 Audio received');
        break;
      case 'document':
        console.log('📄 Document received');
        break;
      case 'sticker':
        console.log('😄 Sticker received');
        break;
    }
  });
  
  // Listen to message status changes
  client.onAck(async (ack) => {
    const statusMap = {
      '-1': 'failed',
      '0': 'pending',
      '1': 'sent',
      '2': 'delivered',
      '3': 'read',
      '4': 'played'
    };
    
    const status = statusMap[ack.ack.toString()] || 'unknown';
    console.log(`📋 Message ${ack.id} status: ${status}`);
    
    await updateMessageStatus(ack.id, status);
  });
  
  client.onStateChange((state) => {
    console.log('🔄 Connection state changed:', state);
    
    if (state === 'CONFLICT') {
      console.log('⚠️ Connection conflict detected, taking over...');
      client.useHere();
    }
    
    if (state === 'UNPAIRED') {
      console.log('📱 Device unpaired, need to scan QR again');
    }
  });
  
  client.onStreamChange((state) => {
    console.log('🌊 Stream state:', state);
    
    if (state === 'DISCONNECTED') {
      console.log('🔴 Disconnected from WhatsApp');
    }
  });
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down gracefully...');

  try {
    // Close all active sessions
    for (let sessionName in activeSessions) {
      console.log(`🔒 Closing session: ${sessionName}`);
      await activeSessions[sessionName].close();
    }

    // Close database connection
    if (db) {
      await db.end();
      console.log('🗄️ Database connection closed.');
    }

    console.log('✅ Shutdown complete.');
    process.exit(0);

  } catch (error) {
    console.error('❌ Error during shutdown:', error);
    process.exit(1);
  }
});

// Start the application
async function main() {
  console.log('🚀 Starting WhatsApp Multi-Agent Tracker...');
  
  await initDatabase();

  await loadAllAgentSessions(); // Load sessions on boot

  console.log('✅ System is ready and all sessions are running!');
}

app.post('/add-session', async (req, res) => {
  const sessionName = `agent_${Date.now()}`;
  
  try {
    await db.execute('INSERT INTO sessions (session_name) VALUES (?)', [sessionName]);
    startAgentSession(sessionName);
    activeSessions[sessionName] = true;

    res.json({ success: true, message: `Session ${sessionName} started successfully`, sessionName: sessionName });
  } catch (error) {
    console.error('Error creating new session:', error);
    res.status(500).json({ success: false, message: 'Error creating new session' });
  }
});

app.get('/qr/:sessionName', (req, res) => {
  const sessionName = req.params.sessionName;

  if (qrCodes[sessionName]) {
    res.json({
      sessionName,
      qr: qrCodes[sessionName].base64Qr,
      attempts: qrCodes[sessionName].attempts
    });
  } else {
    res.status(404).json({ message: 'QR not available or session already connected' });
  }
});

app.post('/send-message', async (req, res) => {
  const { session, to, type, content } = req.body;

  if (!session || !to || !type || !content) {
    return res.status(400).json({ error: 'Missing required fields: session, to, type, content' });
  }

  const client = activeSessions[session];
  if (!client) {
    return res.status(404).json({ error: 'Session not found or not active' });
  }

  try {
    let result;

    switch (type) {
      case 'text':
        result = await client.sendText(to, content.message);
        break;

      case 'poll':
        result = await client.sendPollCreation(to, content.poll);
        break;

      case 'list':
        result = await client.sendListMenu(to, content.title, content.subTitle, content.description, content.buttonText, content.list);
        break;

      case 'buttons':
        result = await client.sendButtons(to, content.title, content.description, content.buttons);
        break;

      case 'voice':
        result = await client.sendVoice(to, content.filePath);
        break;

      case 'voiceBase64':
        result = await client.sendVoiceBase64(to, content.base64Audio);
        break;

      case 'location':
        result = await client.sendLocation(to, content.lat, content.lng, content.title);
        break;

      case 'linkPreview':
        result = await client.sendLinkPreview(to, content.link, content.text);
        break;

      case 'image':
        result = await client.sendImage(to, content.filePath, content.fileName, content.caption);
        break;

      case 'file':
        result = await client.sendFile(to, content.filePath, content.fileName, content.caption);
        break;

      case 'seen':
        result = await client.sendSeen(to);
        break;

      default:
        return res.status(400).json({ error: 'Invalid message type' });
    }

    res.json({ success: true, result });

  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ error: 'Failed to send message', details: error });
  }
});


app.listen(4000, () => console.log('✅ Session API is running on port 4000'));

// Run the application
if (require.main === module) {
  main().catch(console.error);
}