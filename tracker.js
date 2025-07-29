const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const sql = require('mssql');
const fs = require('fs');
const path = require('path');
const express = require('express');
const qrcode = require('qrcode');
const cors = require('cors');
const multer = require('multer');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);

// Configure Socket.IO with CORS
const io = socketIo(server, {
  cors: {
    origin: "*", // In production, specify your frontend URL
    methods: ["GET", "POST"]
  }
});

app.use(express.json());
app.use(cors());

// Configure multer for file uploads
const upload = multer({ dest: 'uploads/' });

let activeSessions = {}; // Must be global
let qrCodes = {}; // Must be global
let sessionStatuses = {}; // Track session readiness

// Database configuration
const dbConfig = {
  user: 'General@Cyrus',
  password: 'CyrusGeneral@Password',
  server: 'localhost',
  database: 'whatsap_tracker',
  options: {
    encrypt: false,
    trustServerCertificate: true
  }
};

let db;

// Create media directory if it doesn't exist
const mediaDir = path.join(__dirname, 'media');
if (!fs.existsSync(mediaDir)) {
  fs.mkdirSync(mediaDir, { recursive: true });
}

// Real-time event emitter functions
function emitNewMessage(sessionName, message, direction) {
  const eventData = {
    sessionName,
    direction, // 'sent' or 'received'
    messageId: message.id.id,
    from: message.from,
    to: message.to,
    body: message.body || `[${message.type.toUpperCase()}]`,
    type: message.type,
    isGroup: message.from.includes('@g.us') || message.to.includes('@g.us'),
    hasMedia: message.hasMedia,
    timestamp: new Date(message.timestamp * 1000).toISOString(),
    fromMe: message.fromMe
  };

  // Emit to all connected clients
  io.emit('new-message', eventData);
  
  // Emit to specific session channel
  io.emit(`session-${sessionName}`, eventData);
  
  // Emit to specific chat channel
  const chatId = message.fromMe ? message.to : message.from;
  io.emit(`chat-${chatId}`, eventData);

  console.log(`🔴 Real-time event emitted: ${direction} message for session ${sessionName}`);
}

function emitMessageStatusUpdate(messageId, status, sessionName) {
  const eventData = {
    messageId,
    status,
    sessionName,
    timestamp: new Date().toISOString()
  };

  io.emit('message-status-update', eventData);
  io.emit(`session-${sessionName}`, { type: 'status-update', ...eventData });

  console.log(`🔴 Real-time status update emitted: ${messageId} -> ${status}`);
}

function emitSessionStatusUpdate(sessionName, status) {
  const eventData = {
    sessionName,
    status,
    timestamp: new Date().toISOString()
  };

  io.emit('session-status-update', eventData);
  io.emit(`session-${sessionName}`, { type: 'session-status', ...eventData });

  console.log(`🔴 Real-time session status emitted: ${sessionName} -> ${status}`);
}

function emitQRCode(sessionName, qrData) {
  const eventData = {
    sessionName,
    qr: qrData.base64Qr,
    qrString: qrData.qrString,
    attempts: qrData.attempts,
    timestamp: new Date().toISOString()
  };

  io.emit('qr-code', eventData);
  io.emit(`session-${sessionName}`, { type: 'qr-code', ...eventData });

  console.log(`🔴 Real-time QR code emitted for session: ${sessionName}`);
}

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log(`🔌 Client connected: ${socket.id}`);

  // Handle joining specific channels
  socket.on('join-session', (sessionName) => {
    socket.join(`session-${sessionName}`);
    console.log(`📡 Client ${socket.id} joined session channel: ${sessionName}`);
  });

  socket.on('join-chat', (chatId) => {
    socket.join(`chat-${chatId}`);
    console.log(`📡 Client ${socket.id} joined chat channel: ${chatId}`);
  });

  socket.on('leave-session', (sessionName) => {
    socket.leave(`session-${sessionName}`);
    console.log(`📡 Client ${socket.id} left session channel: ${sessionName}`);
  });

  socket.on('leave-chat', (chatId) => {
    socket.leave(`chat-${chatId}`);
    console.log(`📡 Client ${socket.id} left chat channel: ${chatId}`);
  });

  socket.on('disconnect', () => {
    console.log(`🔌 Client disconnected: ${socket.id}`);
  });
});

async function initDatabase() {
  try {
    db = await sql.connect(dbConfig);
    console.log('✅ SQL Server connected successfully');

    // Create messages table with better structure
    await db.request().query(`
      IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'messages')
      BEGIN
        CREATE TABLE messages (
          id INT IDENTITY(1,1) PRIMARY KEY,
          message_id VARCHAR(255) UNIQUE,
          from_number VARCHAR(50),
          to_number VARCHAR(50),
          message_body NVARCHAR(max),
          message_type VARCHAR(20),
          is_group BIT DEFAULT 0,
          group_id VARCHAR(100),
          timestamp DATETIME DEFAULT GETDATE(),
          is_from_me BIT DEFAULT 0,
          message_status VARCHAR(20) DEFAULT 'pending',
          session_name VARCHAR(255),
          media_url VARCHAR(500),
          media_filename VARCHAR(255),
          media_mimetype VARCHAR(100),
          media_size BIGINT,
          chat_id VARCHAR(255),
          sender_name VARCHAR(255),
          created_at DATETIME DEFAULT GETDATE()
        )
      END
    `);

    // Create sessions table with agent_name column
    await db.request().query(`
      IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'sessions')
      BEGIN
        CREATE TABLE sessions (
          id INT IDENTITY(1,1) PRIMARY KEY,
          session_name VARCHAR(255) UNIQUE NOT NULL,
          agent_name VARCHAR(255) NOT NULL,
          created_at DATETIME DEFAULT GETDATE()
        )
      END
      ELSE
      BEGIN
        -- Add agent_name column if it doesn't exist (for existing databases)
        IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.COLUMNS 
                      WHERE TABLE_NAME = 'sessions' AND COLUMN_NAME = 'agent_name')
        BEGIN
          ALTER TABLE sessions ADD agent_name VARCHAR(255) NOT NULL DEFAULT 'Unknown Agent'
        END
      END
    `);

    // Create chats table - NEW
    await db.request().query(`
      IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'chats')
      BEGIN
        CREATE TABLE chats (
          id INT IDENTITY(1,1) PRIMARY KEY,
          chat_id VARCHAR(255) UNIQUE NOT NULL,
          chat_name NVARCHAR(255),
          chat_type VARCHAR(20) NOT NULL, -- 'individual' or 'group'
          participant_number VARCHAR(50), -- For individual chats
          group_name VARCHAR(255), -- For group chats
          last_message_id VARCHAR(255),
          last_message_text NVARCHAR(max),
          last_message_time DATETIME,
          last_message_from VARCHAR(50),
          unread_count INT DEFAULT 0,
          is_active BIT DEFAULT 1,
          session_name VARCHAR(255),
          created_at DATETIME DEFAULT GETDATE(),
          updated_at DATETIME DEFAULT GETDATE(),
          FOREIGN KEY (last_message_id) REFERENCES messages(message_id)
        )
      END
    `);

    console.log('✅ Tables ready (messages, sessions with agent_name, chats)');
  } catch (error) {
    console.error('❌ Database connection failed:', error);
  }
}

// Function to download and save media
async function downloadMedia(message) {
  try {
    if (!message.hasMedia) {
      return null;
    }

    console.log(`📥 Downloading media for message: ${message.id.id}`);
    
    const media = await message.downloadMedia();
    
    if (!media) {
      console.log('❌ Failed to download media');
      return null;
    }

    const timestamp = Date.now();
    const extension = getFileExtension(media.mimetype || 'application/octet-stream');
    const filename = `${message.type}_${timestamp}_${message.id.id.split('_')[2] || 'unknown'}${extension}`;
    const filepath = path.join(mediaDir, filename);
    
    const buffer = Buffer.from(media.data, 'base64');
    fs.writeFileSync(filepath, buffer);
    
    console.log(`✅ Media saved: ${filename}`);
    
    return {
      filename: filename,
      filepath: filepath,
      size: buffer.length,
      mimetype: media.mimetype
    };
    
  } catch (error) {
    console.error('Error downloading media:', error);
    return null;
  }
}

async function updateOrCreateChat(message, sessionName) {
  try {
    // Determine chat details
    let chatId, chatType, participantNumber, groupName, chatName;
    
    if (message.from.includes('@g.us') || message.to.includes('@g.us')) {
      // Group chat
      chatId = message.from.includes('@g.us') ? message.from : message.to;
      chatType = 'group';
      participantNumber = null;
      
      // Try to get group name
      try {
        const chat = await message.getChat();
        groupName = chat.name || 'Unknown Group';
        chatName = groupName;
      } catch (error) {
        groupName = 'Unknown Group';
        chatName = 'Unknown Group';
      }
    } else {
      // Individual chat
      chatId = message.fromMe ? message.to : message.from;
      chatType = 'individual';
      participantNumber = message.fromMe ? message.to : message.from;
      groupName = null;
      
      // Try to get contact name
      try {
        const contact = await message.getContact();
        chatName = contact.pushname || contact.name || participantNumber;
      } catch (error) {
        chatName = participantNumber;
      }
    }

    // Check if chat exists
    const existingChat = await db.request()
      .input('chat_id', sql.VarChar, chatId)
      .input('session_name', sql.VarChar, sessionName)
      .query('SELECT id FROM chats WHERE chat_id = @chat_id AND session_name = @session_name');

    const messageText = message.body || `[${message.type.toUpperCase()}]`;
    const messageTime = new Date(message.timestamp * 1000);
    const messageFrom = message.fromMe ? 'You' : (message.from || 'Unknown');

    if (existingChat.recordset.length > 0) {
      // Update existing chat
      await db.request()
        .input('chat_id', sql.VarChar, chatId)
        .input('session_name', sql.VarChar, sessionName)
        .input('last_message_id', sql.VarChar, message.id.id)
        .input('last_message_text', sql.NVarChar(sql.MAX), messageText)
        .input('last_message_time', sql.DateTime, messageTime)
        .input('last_message_from', sql.VarChar, messageFrom)
        .input('chat_name', sql.NVarChar(sql.MAX), chatName)
        .input('updated_at', sql.DateTime, new Date())
        .query(`
          UPDATE chats SET 
            last_message_id = @last_message_id,
            last_message_text = @last_message_text,
            last_message_time = @last_message_time,
            last_message_from = @last_message_from,
            chat_name = @chat_name,
            updated_at = @updated_at
          WHERE chat_id = @chat_id AND session_name = @session_name
        `);
    } else {
      // Create new chat
      await db.request()
        .input('chat_id', sql.VarChar, chatId)
        .input('chat_name', sql.VarChar, chatName)
        .input('chat_type', sql.VarChar, chatType)
        .input('participant_number', sql.VarChar, participantNumber)
        .input('group_name', sql.VarChar, groupName)
        .input('last_message_id', sql.VarChar, message.id.id)
        .input('last_message_text', sql.NVarChar(sql.MAX), messageText)
        .input('last_message_time', sql.DateTime, messageTime)
        .input('last_message_from', sql.VarChar, messageFrom)
        .input('session_name', sql.VarChar, sessionName)
        .query(`
          INSERT INTO chats (
            chat_id, chat_name, chat_type, participant_number, group_name,
            last_message_id, last_message_text, last_message_time, last_message_from,
            session_name
          ) VALUES (
            @chat_id, @chat_name, @chat_type, @participant_number, @group_name,
            @last_message_id, @last_message_text, @last_message_time, @last_message_from,
            @session_name
          )
        `);
    }

    console.log(`💬 Chat updated: ${chatName} (${chatType})`);
  } catch (error) {
    console.error('❌ Error updating chat:', error);
  }
}

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
    'audio/mpeg; codecs=opus': '.ogg',
    'application/pdf': '.pdf',
    'application/msword': '.doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'text/plain': '.txt'
  };
  
  return extensions[mimetype] || '.bin';
}

// Enhanced function to save message with better error handling
async function saveMessage(message, sessionName) {
  try {
    // Check if message already exists
    const checkResult = await db.request()
      .input('message_id', sql.VarChar, message.id.id)
      .query('SELECT COUNT(*) as count FROM messages WHERE message_id = @message_id');

    if (checkResult.recordset[0].count > 0) {
      console.log(`⚠️ Message already exists: ${message.id.id}`);
      return;
    }

    let mediaInfo = null;
    if (message.hasMedia) {
      mediaInfo = await downloadMedia(message);
    }

    // Get contact info for sender name
    let senderName = null;
    try {
      if (!message.fromMe) {
        const contact = await message.getContact();
        senderName = contact.pushname || contact.name || contact.number;
      }
    } catch (error) {
      console.log('Could not get contact info:', error.message);
    }

    // Get chat info
    let chatId = message.from;
    if (message.from.includes('@g.us')) {
      chatId = message.from; // Group chat
    } else {
      chatId = message.fromMe ? message.to : message.from; // Individual chat
    }

    const query = `
      INSERT INTO messages (
        message_id, from_number, to_number, message_body, 
        message_type, is_group, group_id, is_from_me, message_status,
        session_name, media_filename, media_mimetype, media_size,
        chat_id, sender_name, timestamp
      ) VALUES (
        @message_id, @from_number, @to_number, @message_body, 
        @message_type, @is_group, @group_id, @is_from_me, @message_status, 
        @session_name, @media_filename, @media_mimetype, @media_size,
        @chat_id, @sender_name, @timestamp
      )
    `;

    await db.request()
      .input('message_id', sql.VarChar, message.id.id)
      .input('from_number', sql.VarChar, message.from)
      .input('to_number', sql.VarChar, message.to)
      .input('message_body', sql.NVarChar(sql.MAX), message.body || (mediaInfo ? `[${message.type.toUpperCase()}]` : ''))
      .input('message_type', sql.VarChar, message.from.includes('@g.us') || message.to.includes('@g.us') ? 'group' : 'Chat')
      .input('is_group', sql.Bit, message.from.includes('@g.us') || message.to.includes('@g.us'))
      .input('group_id', sql.VarChar, message.from.includes('@g.us') ? message.from : null)
      .input('is_from_me', sql.Bit, message.fromMe)
      .input('message_status', sql.VarChar, message.fromMe ? 'sent' : 'received')
      .input('session_name', sql.VarChar, sessionName)
      .input('media_filename', sql.VarChar, mediaInfo ? mediaInfo.filename : null)
      .input('media_mimetype', sql.VarChar, mediaInfo ? mediaInfo.mimetype : null)
      .input('media_size', sql.BigInt, mediaInfo ? mediaInfo.size : null)
      .input('chat_id', sql.VarChar, chatId)
      .input('sender_name', sql.VarChar, senderName)
      .input('timestamp', sql.DateTime, new Date(message.timestamp * 1000))
      .query(query);

    // Update or create chat entry
    await updateOrCreateChat(message, sessionName);

    // Emit real-time event
    const direction = message.fromMe ? 'sent' : 'received';
    emitNewMessage(sessionName, message, direction);

    const mediaText = mediaInfo ? '(with media)' : '';
    console.log(`✅ ${direction.toUpperCase()} message saved: ${message.id.id} ${mediaText}`);
    console.log(`   From: ${message.from} | To: ${message.to} | Body: ${message.body || '[Media]'}`);

  } catch (error) {
    console.error('❌ Error saving message:', error);
  }
}

// Function to update message status
async function updateMessageStatus(messageId, status) {
  try {
    await db.request()
      .input('status', sql.VarChar, status)
      .input('message_id', sql.VarChar, messageId)
      .query('UPDATE messages SET message_status = @status WHERE message_id = @message_id');

    // Get session name for the message to emit real-time update
    const result = await db.request()
      .input('message_id', sql.VarChar, messageId)
      .query('SELECT session_name FROM messages WHERE message_id = @message_id');

    if (result.recordset.length > 0) {
      const sessionName = result.recordset[0].session_name;
      emitMessageStatusUpdate(messageId, status, sessionName);
    }

    console.log(`📋 Message ${messageId} status updated to: ${status}`);
  } catch (error) {
    console.error('Error updating message status:', error);
  }
}

// NEW FUNCTION: Send message
async function sendMessage(sessionName, phoneNumber, messageText, mediaPath = null, caption = null) {
  try {
    const client = activeSessions[sessionName];
    
    if (!client || !isClientReady(sessionName)) {
      throw new Error('Session not ready or not found');
    }

    const formattedNumber = formatPhoneNumber(phoneNumber);
    let sentMessage;

    if (mediaPath && fs.existsSync(mediaPath)) {
      // Send media message
      const media = MessageMedia.fromFilePath(mediaPath);
      sentMessage = await client.sendMessage(formattedNumber, media, { caption: caption || messageText });
      console.log(`📤 Media message sent via ${sessionName} to ${formattedNumber}`);
    } else {
      // Send text message
      sentMessage = await client.sendMessage(formattedNumber, messageText);
      console.log(`📤 Text message sent via ${sessionName} to ${formattedNumber}: ${messageText}`);
    }

    // The message will be automatically saved by the message listener
    return {
      success: true,
      messageId: sentMessage.id.id,
      to: formattedNumber,
      body: messageText,
      hasMedia: !!mediaPath,
      timestamp: new Date().toISOString()
    };

  } catch (error) {
    console.error(`❌ Error sending message via ${sessionName}:`, error);
    throw error;
  }
}

// Initialize WhatsApp Web Client
async function startAgentSession(sessionName) {
  try {
    const client = new Client({
      authStrategy: new LocalAuth({ 
        clientId: sessionName,
        dataPath: path.join(__dirname, 'sessions')
      }),
      puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      }
    });

    // QR Code generation
    client.on('qr', async (qr) => {
      console.log(`🆕 QR Code for session ${sessionName}:`);
      console.log(qr);

      const qrBase64 = await qrcode.toDataURL(qr);
      const qrData = { 
        base64Qr: qrBase64,
        qrString: qr,
        attempts: 1
      };
      
      qrCodes[sessionName] = qrData;
      
      // Emit real-time QR code event
      emitQRCode(sessionName, qrData);
    });

    // Authentication success
    client.on('authenticated', () => {
      console.log(`✅ Session ${sessionName} is authenticated`);
      sessionStatuses[sessionName] = 'authenticated';
      emitSessionStatusUpdate(sessionName, 'authenticated');
    });

    // Client ready
    client.on('ready', async () => {
      console.log(`✅ Session ${sessionName} is ready`);
      sessionStatuses[sessionName] = 'ready';
      emitSessionStatusUpdate(sessionName, 'ready');
      
      delete qrCodes[sessionName];
      
      try {
        const info = client.info;
        console.log(`📱 Client info for ${sessionName}:`, info.wid.user);
      } catch (error) {
        console.log(`⚠️ Could not get client info for ${sessionName}`);
      }
    });

    // Authentication failure
    client.on('auth_failure', (message) => {
      console.error(`❌ Authentication failed for ${sessionName}:`, message);
      sessionStatuses[sessionName] = 'auth_failure';
      emitSessionStatusUpdate(sessionName, 'auth_failure');
    });

    // Client disconnected
    client.on('disconnected', (reason) => {
      console.log(`🔴 Session ${sessionName} disconnected:`, reason);
      sessionStatuses[sessionName] = 'disconnected';
      emitSessionStatusUpdate(sessionName, 'disconnected');
      delete activeSessions[sessionName];
    });

    // Setup enhanced event listeners
    setupEventListeners(client, sessionName);

    sessionStatuses[sessionName] = 'initializing';
    emitSessionStatusUpdate(sessionName, 'initializing');
    await client.initialize();
    
    activeSessions[sessionName] = client;
    console.log(`✅ Agent session started: ${sessionName}`);

  } catch (error) {
    console.error(`❌ Failed to start session ${sessionName}:`, error);
  }
}

function setupEventListeners(client, sessionName) {
  // MAIN MESSAGE LISTENER - This captures ALL messages (sent and received)
  client.on('message', async (message) => {
    
    const direction = message.fromMe ? '📤 SENT' : '📥 RECEIVED';
    const isGroup = message.from.includes('@g.us');
    const chatType = isGroup ? 'GROUP' : 'INDIVIDUAL';
    const mediaType = message.hasMedia ? `[${message.type.toUpperCase()}]` : '';
    
    console.log(`${direction} ${chatType} Message:`, {
      id: message.id.id,
      from: message.from,
      to: message.to,
      body: message.body || mediaType,
      type: message.type,
      fromMe: message.fromMe,
      isGroup: isGroup,
      hasMedia: message.hasMedia,
      timestamp: new Date(message.timestamp * 1000).toISOString()
    });
    
    // Save to database (this will also emit real-time events)
    await saveMessage(message, sessionName);
  });

  // ADDITIONAL MESSAGE LISTENERS for different types
  client.on('message_create', async (message) => {
    // This event fires when a message is created (including sent messages)
    const direction = message.fromMe ? '📤 SENT' : '📥 RECEIVED';
    const isGroup = message.from.includes('@g.us') || message.to.includes('@g.us');
    const chatType = isGroup ? 'GROUP' : 'INDIVIDUAL';

    const mediaType = message.hasMedia ? `[${message.type.toUpperCase()}]` : '';
    
    console.log(`${direction} ${chatType} Message:`, {
      id: message.id.id,
      from: message.from,
      to: message.to,
      body: message.body || mediaType,
      type: message.type,
      fromMe: message.fromMe,
      isGroup: isGroup,
      hasMedia: message.hasMedia,
      timestamp: new Date(message.timestamp * 1000).toISOString()
    });
    
    // Save to database (this will also emit real-time events)
    await saveMessage(message, sessionName);

    console.log(`🔄 Message created: ${message.id.id} | FromMe: ${message.fromMe}`);
  });

  // Listen to message revokes
  client.on('message_revoke_everyone', async (after, before) => {
    console.log('🗑️ Message revoked for everyone:', before?.body || 'Media message');
    
    if (before && before.id) {
      await updateMessageStatus(before.id.id, 'revoked');
    }
  });

  client.on('message_revoke_me', async (message) => {
    console.log('🗑️ Message revoked for me:', message.body || 'Media message');
    
    if (message.id) {
      await updateMessageStatus(message.id.id, 'revoked_me');
    }
  });

  // Listen to message acknowledgments (only for sent messages)
  client.on('message_ack', async (message, ack) => {
    const statusMap = {
      1: 'sent',
      2: 'delivered',
      3: 'read',
      4: 'played'
    };
    
    const status = statusMap[ack] || 'unknown';
    console.log(`📋 Message acknowledgment: ${message.id.id} -> ${status}`);
    
    await updateMessageStatus(message.id.id, status);
  });

  // Group events
  client.on('group_join', (notification) => {
    console.log('👥 Someone joined group:', notification);
  });

  client.on('group_leave', (notification) => {
    console.log('👋 Someone left group:', notification);
  });

  // Contact events
  client.on('contact_changed', (message, oldId, newId, isContact) => {
    console.log('📞 Contact changed:', { oldId, newId, isContact });
  });

  // Auto-reply example (optional)
  client.on('message', async (message) => {
    // Only respond to received messages, not sent ones
    if (!message.fromMe && message.body && message.body.toLowerCase() === 'ping') {
      try {
        await client.sendMessage(message.from, 'pong! 🏓');
        console.log('🤖 Auto-reply sent');
      } catch (error) {
        console.error('Error sending auto-reply:', error);
      }
    }
  });

  // Log different media types
  client.on('message', async (message) => {
    if (message.hasMedia) {
      switch (message.type) {
        case 'ptt':
          console.log('🎤 Voice message detected');
          break;
        case 'image':
          console.log('🖼️ Image detected');
          break;
        case 'video':
          console.log('🎥 Video detected');
          break;
        case 'audio':
          console.log('🎵 Audio detected');
          break;
        case 'document':
          console.log('📄 Document detected');
          break;
        case 'sticker':
          console.log('😄 Sticker detected');
          break;
      }
    }
  });
}

async function loadAllAgentSessions() {
  try {
    const result = await db.request().query('SELECT session_name FROM sessions');
    const sessions = result.recordset;

    if (sessions.length === 0) {
      console.log('⚠️ No sessions found in the database');
      return;
    }

    console.log(`📋 Loading ${sessions.length} sessions...`);
    
    for (let session of sessions) {
      console.log(`🔄 Starting session: ${session.session_name}`);
      await startAgentSession(session.session_name);
      // Add small delay between sessions to avoid overwhelming
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    console.log('✅ All sessions loaded successfully');
  } catch (error) {
    console.error('❌ Error loading sessions:', error);
  }
}

// Helper function to check if client is ready
function isClientReady(sessionName) {
  return sessionStatuses[sessionName] === 'ready' && activeSessions[sessionName];
}

// Helper function to format phone number
function formatPhoneNumber(phoneNumber) {
  let cleaned = phoneNumber.replace(/\D/g, '');
  
  if (!phoneNumber.includes('@')) {
    if (cleaned.length === 10) {
      cleaned = '1' + cleaned;
    }
    return cleaned + '@c.us';
  }
  
  return phoneNumber;
}

function createResponse(success, data = null, message = '', pagination = null) {
  const response = {
    success,
    message,
    timestamp: new Date().toISOString()
  };

  if (data !== null) {
    response.data = data;
  }

  if (pagination) {
    response.pagination = pagination;
  }

  return response;
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down gracefully...');

  try {
    for (let sessionName in activeSessions) {
      console.log(`🔒 Closing session: ${sessionName}`);
      await activeSessions[sessionName].destroy();
    }

    if (db) {
      await sql.close();
      console.log('🗄️ Database connection closed.');
    }

    server.close(() => {
      console.log('🔌 HTTP server closed.');
    });

    console.log('✅ Shutdown complete.');
    process.exit(0);

  } catch (error) {
    console.error('❌ Error during shutdown:', error);
    process.exit(1);
  }
});

// API Endpoints
app.get('/tracker/health', async (req, res) => {
  try {    
    res.json("hello from tracker");
  } catch (error) {
    console.error('Health check error:', error);
    res.status(500).json(createResponse(false, error, 'Service unhealthy'));
  }
});

// Updated add-session endpoint that accepts agent name
app.post('/add-session', async (req, res) => {
  const agentName = req.query.agentName;

  // Validate agent name
  if (!agentName || typeof agentName !== 'string' || agentName.trim() === '') {
    return res.status(400).json({ 
      success: false, 
      message: 'Agent name is required and must be a non-empty string' 
    });
  }

  // Clean the agent name (remove special characters, spaces, etc.)
  const cleanAgentName = agentName.trim().replace(/[^a-zA-Z0-9_-]/g, '_');
  const sessionName = `agent_${cleanAgentName}_${Date.now()}`;
  
  try {
    // Check if an agent with this name already exists
    const existingAgent = await db.request()
      .input('session_name_pattern', sql.VarChar, `agent_${cleanAgentName}_%`)
      .query('SELECT session_name FROM sessions WHERE session_name LIKE @session_name_pattern');

    if (existingAgent.recordset.length > 0) {
      return res.status(409).json({ 
        success: false, 
        message: `An agent with name "${cleanAgentName}" already exists`,
        existingSessions: existingAgent.recordset.map(r => r.session_name)
      });
    }

    // Add the session to database
    await db.request()
      .input('session_name', sql.VarChar, sessionName)
      .input('agent_name', sql.VarChar, agentName)
      .query('INSERT INTO sessions (session_name, agent_name) VALUES (@session_name, @agent_name)');

    // Start the WhatsApp session
    await startAgentSession(sessionName);

    console.log(`✅ New agent session created: ${sessionName} (Agent: ${agentName})`);

    res.json({ 
      success: true, 
      message: `Agent "${agentName}" session started successfully`, 
      sessionName: sessionName,
      agentName: cleanAgentName,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error creating new session:', error);
    
    // Clean up if session was added to database but WhatsApp client failed
    try {
      await db.request()
        .input('session_name', sql.VarChar, sessionName)
        .query('DELETE FROM sessions WHERE session_name = @session_name');
    } catch (cleanupError) {
      console.error('Error cleaning up failed session:', cleanupError);
    }

    res.status(500).json({ 
      success: false, 
      message: 'Error creating new agent session',
      error: error.message 
    });
  }
});

// NEW ENDPOINT: Send text message
app.post('/send-message/:sessionName', async (req, res) => {
  const sessionName = req.params.sessionName;
  const { phoneNumber, message, caption } = req.body;

  // Validate required fields
  if (!phoneNumber || !message) {
    return res.status(400).json(createResponse(
      false, 
      null, 
      'Phone number and message are required'
    ));
  }

  // Check if session exists and is ready
  if (!isClientReady(sessionName)) {
    return res.status(400).json(createResponse(
      false, 
      null, 
      `Session "${sessionName}" is not ready or does not exist`
    ));
  }

  try {
    const result = await sendMessage(sessionName, phoneNumber, message);
    
    res.json(createResponse(
      true, 
      result, 
      'Message sent successfully'
    ));

  } catch (error) {
    console.error('Error in send-message endpoint:', error);
    res.status(500).json(createResponse(
      false, 
      null, 
      `Failed to send message: ${error.message}`
    ));
  }
});

// NEW ENDPOINT: Send message with media
app.post('/send-media/:sessionName', upload.single('media'), async (req, res) => {
  const sessionName = req.params.sessionName;
  
  // For multipart/form-data, the text fields are available after multer processes the request
  // Access them from req.body AFTER multer middleware runs
  const phoneNumber = req.body.phoneNumber;
  const message = req.body?.message;
  const caption = req.body?.caption;
  const mediaFile = req.file;

  // Validate required fields
  if (!phoneNumber) {
    return res.status(400).json(createResponse(
      false, 
      null, 
      'Phone number is required'
    ));
  }

  if (!mediaFile && !message) {
    return res.status(400).json(createResponse(
      false, 
      null, 
      'Either media file or message text is required'
    ));
  }

  // Check if session exists and is ready
  if (!isClientReady(sessionName)) {
    return res.status(400).json(createResponse(
      false, 
      null, 
      `Session "${sessionName}" is not ready or does not exist`
    ));
  }

  try {
    const mediaPath = mediaFile ? mediaFile.path : null;
    const messageText = message || caption || '';
    
    const result = await sendMessage(sessionName, phoneNumber, messageText, mediaPath, caption);
    
    // Clean up uploaded file
    if (mediaFile && fs.existsSync(mediaFile.path)) {
      fs.unlinkSync(mediaFile.path);
    }
    
    res.json(createResponse(
      true, 
      result, 
      'Media message sent successfully'
    ));

  } catch (error) {
    console.error('Error in send-media endpoint:', error);
    
    // Clean up uploaded file on error
    if (mediaFile && fs.existsSync(mediaFile.path)) {
      fs.unlinkSync(mediaFile.path);
    }
    
    res.status(500).json(createResponse(
      false, 
      null, 
      `Failed to send media message: ${error.message}`
    ));
  }
});

// NEW ENDPOINT: Send bulk messages
app.post('/send-bulk/:sessionName', async (req, res) => {
  const sessionName = req.params.sessionName;
  const { messages } = req.body; // Array of {phoneNumber, message, delay?}

  // Validate required fields
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json(createResponse(
      false, 
      null, 
      'Messages array is required and must not be empty'
    ));
  }

  // Check if session exists and is ready
  if (!isClientReady(sessionName)) {
    return res.status(400).json(createResponse(
      false, 
      null, 
      `Session "${sessionName}" is not ready or does not exist`
    ));
  }

  const results = [];
  const errors = [];

  try {
    for (let i = 0; i < messages.length; i++) {
      const { phoneNumber, message, delay = 1000 } = messages[i];

      if (!phoneNumber || !message) {
        errors.push({
          index: i,
          error: 'Phone number and message are required',
          phoneNumber,
          message
        });
        continue;
      }

      try {
        const result = await sendMessage(sessionName, phoneNumber, message);
        results.push({
          index: i,
          success: true,
          ...result
        });

        // Add delay between messages to avoid rate limiting
        if (i < messages.length - 1 && delay > 0) {
          await new Promise(resolve => setTimeout(resolve, delay));
        }

      } catch (error) {
        console.error(`Error sending bulk message ${i}:`, error);
        errors.push({
          index: i,
          error: error.message,
          phoneNumber,
          message
        });
      }
    }

    res.json(createResponse(
      true, 
      {
        totalMessages: messages.length,
        successful: results.length,
        failed: errors.length,
        results,
        errors
      }, 
      `Bulk send completed: ${results.length} successful, ${errors.length} failed`
    ));

  } catch (error) {
    console.error('Error in bulk send endpoint:', error);
    res.status(500).json(createResponse(
      false, 
      null, 
      `Failed to send bulk messages: ${error.message}`
    ));
  }
});

// NEW ENDPOINT: Get chat list for a session
app.get('/chats/:sessionName', async (req, res) => {
  const sessionName = req.params.sessionName;
  const { limit = 50, offset = 0, type = 'all' } = req.query;
  
  try {
    let whereClause = 'WHERE session_name = @session_name AND is_active = 1';
    
    if (type === 'individual') {
      whereClause += ' AND chat_type = \'individual\'';
    } else if (type === 'group') {
      whereClause += ' AND chat_type = \'group\'';
    }
    
    const query = `
      SELECT 
        chat_id,
        chat_name,
        chat_type,
        participant_number,
        group_name,
        last_message_text,
        last_message_time,
        last_message_from,
        unread_count,
        updated_at
      FROM chats 
      ${whereClause}
      ORDER BY last_message_time DESC
      OFFSET @offset ROWS
      FETCH NEXT @limit ROWS ONLY
    `;
    
    const result = await db.request()
      .input('session_name', sql.VarChar, sessionName)
      .input('limit', sql.Int, parseInt(limit))
      .input('offset', sql.Int, parseInt(offset))
      .query(query);
    
    res.json(createResponse(
      true, 
      result.recordset, 
      `Found ${result.recordset.length} chats`
    ));
    
  } catch (error) {
    console.error('Error fetching chats:', error);
    res.status(500).json(createResponse(false, null, 'Error fetching chats'));
  }
});

// NEW ENDPOINT: Get messages for a specific chat
app.get('/chat/:sessionName/:chatId/messages', async (req, res) => {
  const { sessionName, chatId } = req.params;
  const { limit = 50, offset = 0 } = req.query;
  
  try {
    const query = `
      SELECT 
        message_id,
        from_number,
        to_number,
        message_body,
        message_type,
        is_group,
        is_from_me,
        message_status,
        media_filename,
        media_mimetype,
        sender_name,
        timestamp,
        created_at
      FROM messages 
      WHERE session_name = @session_name AND chat_id = @chat_id
      ORDER BY timestamp DESC
      OFFSET @offset ROWS
      FETCH NEXT @limit ROWS ONLY
    `;
    
    const result = await db.request()
      .input('session_name', sql.VarChar, sessionName)
      .input('chat_id', sql.VarChar, chatId)
      .input('limit', sql.Int, parseInt(limit))
      .input('offset', sql.Int, parseInt(offset))
      .query(query);
    
    res.json(createResponse(
      true, 
      result.recordset, 
      `Found ${result.recordset.length} messages for chat`
    ));
    
  } catch (error) {
    console.error('Error fetching chat messages:', error);
    res.status(500).json(createResponse(false, null, 'Error fetching chat messages'));
  }
});

// Optional: Add endpoint to list all agents
app.get('/agents', async (req, res) => {
  try {
    const result = await db.request().query(`
      SELECT 
        session_name,
        agent_name,
        created_at
      FROM sessions 
      ORDER BY created_at DESC
    `);

    const agents = result.recordset.map(session => {
      const status = sessionStatuses[session.session_name] || 'inactive';
      
      return {
        sessionName: session.session_name,
        agentName: session.agent_name,
        status: status,
        createdAt: session.created_at,
        isReady: isClientReady(session.session_name),
        hasQR: !!qrCodes[session.session_name]
      };
    });

    res.json(createResponse(true, agents, `Found ${agents.length} agents`));
  } catch (error) {
    console.error('Error fetching agents:', error);
    res.status(500).json(createResponse(false, null, 'Error fetching agents'));
  }
});

// Optional: Add endpoint to get specific agent status
app.get('/agent/:sessionName/status', (req, res) => {
  const sessionName = req.params.sessionName;
  
  const status = sessionStatuses[sessionName] || 'not_found';
  const isReady = isClientReady(sessionName);
  const hasQR = !!qrCodes[sessionName];

  res.json({
    sessionName,
    status,
    isReady,
    hasQR,
    qrAvailable: hasQR ? `/qr/${sessionName}` : null,
    timestamp: new Date().toISOString()
  });
});

app.get('/qr/:sessionName', (req, res) => {
  const sessionName = req.params.sessionName;

  if (qrCodes[sessionName]) {
    res.json({
      sessionName,
      qr: qrCodes[sessionName].base64Qr,
      qrString: qrCodes[sessionName].qrString,
      attempts: qrCodes[sessionName].attempts
    });
  } else {
    res.status(404).json({ message: 'QR not available or session already connected' });
  }
});

// Get messages with filtering
app.get('/messages/:sessionName', async (req, res) => {
  const sessionName = req.params.sessionName;
  const { limit = 50, offset = 0, type = 'all' } = req.query;
  
  try {
    let whereClause = 'WHERE session_name = @session_name';
    
    if (type === 'sent') {
      whereClause += ' AND is_from_me = 1';
    } else if (type === 'received') {
      whereClause += ' AND is_from_me = 0';
    }
    
    const query = `
      SELECT * FROM messages 
      ${whereClause}
      ORDER BY timestamp DESC
      OFFSET @offset ROWS
      FETCH NEXT @limit ROWS ONLY
    `;
    
    const result = await db.request()
      .input('session_name', sql.VarChar, sessionName)
      .input('limit', sql.Int, parseInt(limit))
      .input('offset', sql.Int, parseInt(offset))
      .query(query);
    
    res.json(createResponse(true, result.recordset, `Found ${result.recordset.length} messages`));
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json(createResponse(false, null, 'Error fetching messages'));
  }
});

// NEW ENDPOINT: Get real-time statistics
app.get('/stats/realtime', async (req, res) => {
  try {
    const connectedClients = io.engine.clientsCount;
    const activeSessions = Object.keys(sessionStatuses).filter(session => 
      sessionStatuses[session] === 'ready'
    ).length;
    
    const totalMessages = await db.request().query(
      'SELECT COUNT(*) as count FROM messages WHERE CAST(created_at AS DATE) = CAST(GETDATE() AS DATE)'
    );
    
    const sentToday = await db.request().query(
      'SELECT COUNT(*) as count FROM messages WHERE is_from_me = 1 AND CAST(created_at AS DATE) = CAST(GETDATE() AS DATE)'
    );
    
    const receivedToday = await db.request().query(
      'SELECT COUNT(*) as count FROM messages WHERE is_from_me = 0 AND CAST(created_at AS DATE) = CAST(GETDATE() AS DATE)'
    );

    res.json(createResponse(true, {
      connectedClients,
      activeSessions,
      totalSessionsConfigured: Object.keys(sessionStatuses).length,
      messagesToday: totalMessages.recordset[0].count,
      sentToday: sentToday.recordset[0].count,
      receivedToday: receivedToday.recordset[0].count,
      sessionStatuses
    }, 'Real-time statistics'));
    
  } catch (error) {
    console.error('Error fetching real-time stats:', error);
    res.status(500).json(createResponse(false, null, 'Error fetching statistics'));
  }
});

server.listen(3002, () => {
  console.log('✅ Session API with WebSocket is running on port 3002');
  console.log('🔴 Real-time WebSocket server is active');
  console.log('📡 Message listeners are active for both sent and received messages');
  console.log('📤 Message sending endpoints are available:');
  console.log('   - POST /send-message/:sessionName - Send text message');
  console.log('   - POST /send-media/:sessionName - Send media with message');
  console.log('   - POST /send-bulk/:sessionName - Send bulk messages');
  console.log('   - GET /chats/:sessionName - Get chat list');
  console.log('   - GET /chat/:sessionName/:chatId/messages - Get chat messages');
  console.log('🔴 Real-time events available:');
  console.log('   - new-message: When a message is sent or received');
  console.log('   - message-status-update: When message status changes');
  console.log('   - session-status-update: When session status changes');
  console.log('   - qr-code: When QR code is generated');
});

// Start the application
async function main() {
  console.log('🚀 Starting WhatsApp Multi-Agent Tracker with Real-time Events...');
  console.log('📡 Enhanced message listening enabled');
  console.log('📤 Message sending capabilities enabled');
  console.log('🔴 Real-time WebSocket events enabled');
  
  await initDatabase();
  await loadAllAgentSessions();

  console.log('✅ System is ready and all sessions are running!');
  console.log('🎯 The system will now capture:');
  console.log('   - All SENT messages (from your WhatsApp)');
  console.log('   - All RECEIVED messages (to your WhatsApp)');
  console.log('   - Media files (images, videos, audio, documents)');
  console.log('   - Group and individual chats');
  console.log('   - Message status updates (sent, delivered, read)');
  console.log('📤 The system can now send:');
  console.log('   - Text messages to any WhatsApp number');
  console.log('   - Media messages (images, videos, documents) with captions');
  console.log('   - Bulk messages to multiple recipients');
  console.log('   - Messages through any active agent session');
  console.log('🔴 Real-time features:');
  console.log('   - Live message notifications');
  console.log('   - Session status updates');
  console.log('   - Message status tracking');
  console.log('   - QR code updates');
}

if (require.main === module) {
  main().catch(console.error);
}