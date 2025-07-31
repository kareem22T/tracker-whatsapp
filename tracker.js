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
    encrypt: false, // set to true if using Azure or SSL
    trustServerCertificate: true // for local development
  }
};

let db;

// Create media directory if it doesn't exist
const mediaDir = path.join(__dirname, 'media');
if (!fs.existsSync(mediaDir)) {
  fs.mkdirSync(mediaDir, { recursive: true });
}

// Real-time event emitter functions
function emitNewMessage(sessionName, message, direction, participantInfo = null) {
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
    fromMe: message.fromMe,
    // Enhanced participant information
    participantName: participantInfo ? participantInfo.displayName : null,
    participantPhone: participantInfo ? participantInfo.phone : null,
    contactPushname: participantInfo ? participantInfo.pushname : null,
    // Reply information
    isReply: participantInfo ? participantInfo.isReply : false,
    quotedMessageId: participantInfo ? participantInfo.quotedMessageId : null,
    quotedMessageBody: participantInfo ? participantInfo.quotedMessageBody : null,
    quotedMessageFrom: participantInfo ? participantInfo.quotedMessageFrom : null,
    quotedMessageType: participantInfo ? participantInfo.quotedMessageType : null
  };

  // Emit to all connected clients
  io.emit('new-message', eventData);
  
  // Emit to specific session channel
  io.emit(`session-${sessionName}`, eventData);
  
  // Emit to specific chat channel
  const chatId = message.fromMe ? message.to : message.from;
  io.emit(`chat-${chatId}`, eventData);

  const replyText = eventData.isReply ? ' (REPLY)' : '';
  console.log(`🔴 Real-time event emitted: ${direction} message${replyText} for session ${sessionName} from ${participantInfo?.displayName || 'Unknown'}`);
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

    // Create messages table with enhanced structure including reply support
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
          created_at DATETIME DEFAULT GETDATE(),
          -- Enhanced participant tracking columns
          participant_name NVARCHAR(255),
          participant_phone VARCHAR(50),
          contact_pushname NVARCHAR(255),
          -- Reply support columns
          is_reply BIT DEFAULT 0,
          quoted_message_id VARCHAR(255),
          quoted_message_body NVARCHAR(max),
          quoted_message_from VARCHAR(255),
          quoted_message_type VARCHAR(50),
          quoted_message_timestamp DATETIME
        )
        
        -- Create indexes for better performance
        CREATE INDEX IX_messages_participant_phone ON messages(participant_phone);
        CREATE INDEX IX_messages_participant_name ON messages(participant_name);
        CREATE INDEX IX_messages_is_reply ON messages(is_reply);
        CREATE INDEX IX_messages_quoted_message_id ON messages(quoted_message_id);
        CREATE INDEX IX_messages_session_name ON messages(session_name);
        CREATE INDEX IX_messages_chat_id ON messages(chat_id);
        CREATE INDEX IX_messages_timestamp ON messages(timestamp);
        CREATE INDEX IX_messages_message_status ON messages(message_status);
        CREATE INDEX IX_messages_from_number ON messages(from_number);
        CREATE INDEX IX_messages_to_number ON messages(to_number);
        
        PRINT 'Messages table created with reply support'
      END
      ELSE
      BEGIN
        -- Add new columns if they don't exist (for existing databases)
        
        -- Enhanced participant tracking columns
        IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.COLUMNS 
                      WHERE TABLE_NAME = 'messages' AND COLUMN_NAME = 'participant_name')
        BEGIN
          ALTER TABLE messages ADD participant_name NVARCHAR(255);
          PRINT 'Added participant_name column'
        END
        
        IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.COLUMNS 
                      WHERE TABLE_NAME = 'messages' AND COLUMN_NAME = 'participant_phone')
        BEGIN
          ALTER TABLE messages ADD participant_phone VARCHAR(50);
          PRINT 'Added participant_phone column'
        END
        
        IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.COLUMNS 
                      WHERE TABLE_NAME = 'messages' AND COLUMN_NAME = 'contact_pushname')
        BEGIN
          ALTER TABLE messages ADD contact_pushname NVARCHAR(255);
          PRINT 'Added contact_pushname column'
        END
        
        -- Reply support columns
        IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.COLUMNS 
                      WHERE TABLE_NAME = 'messages' AND COLUMN_NAME = 'is_reply')
        BEGIN
          ALTER TABLE messages ADD is_reply BIT DEFAULT 0;
          PRINT 'Added is_reply column'
        END
        
        IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.COLUMNS 
                      WHERE TABLE_NAME = 'messages' AND COLUMN_NAME = 'quoted_message_id')
        BEGIN
          ALTER TABLE messages ADD quoted_message_id VARCHAR(255);
          PRINT 'Added quoted_message_id column'
        END
        
        IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.COLUMNS 
                      WHERE TABLE_NAME = 'messages' AND COLUMN_NAME = 'quoted_message_body')
        BEGIN
          ALTER TABLE messages ADD quoted_message_body NVARCHAR(max);
          PRINT 'Added quoted_message_body column'
        END
        
        IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.COLUMNS 
                      WHERE TABLE_NAME = 'messages' AND COLUMN_NAME = 'quoted_message_from')
        BEGIN
          ALTER TABLE messages ADD quoted_message_from VARCHAR(255);
          PRINT 'Added quoted_message_from column'
        END
        
        IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.COLUMNS 
                      WHERE TABLE_NAME = 'messages' AND COLUMN_NAME = 'quoted_message_type')
        BEGIN
          ALTER TABLE messages ADD quoted_message_type VARCHAR(50);
          PRINT 'Added quoted_message_type column'
        END
        
        IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.COLUMNS 
                      WHERE TABLE_NAME = 'messages' AND COLUMN_NAME = 'quoted_message_timestamp')
        BEGIN
          ALTER TABLE messages ADD quoted_message_timestamp DATETIME;
          PRINT 'Added quoted_message_timestamp column'
        END
        
        -- Create missing indexes
        IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_messages_participant_phone' AND object_id = OBJECT_ID('messages'))
        BEGIN
          CREATE INDEX IX_messages_participant_phone ON messages(participant_phone);
          PRINT 'Created IX_messages_participant_phone index'
        END
        
        IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_messages_participant_name' AND object_id = OBJECT_ID('messages'))
        BEGIN
          CREATE INDEX IX_messages_participant_name ON messages(participant_name);
          PRINT 'Created IX_messages_participant_name index'
        END
        
        IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_messages_is_reply' AND object_id = OBJECT_ID('messages'))
        BEGIN
          CREATE INDEX IX_messages_is_reply ON messages(is_reply);
          PRINT 'Created IX_messages_is_reply index'
        END
        
        IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_messages_quoted_message_id' AND object_id = OBJECT_ID('messages'))
        BEGIN
          CREATE INDEX IX_messages_quoted_message_id ON messages(quoted_message_id);
          PRINT 'Created IX_messages_quoted_message_id index'
        END
        
        IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_messages_session_name' AND object_id = OBJECT_ID('messages'))
        BEGIN
          CREATE INDEX IX_messages_session_name ON messages(session_name);
          PRINT 'Created IX_messages_session_name index'
        END
        
        IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_messages_chat_id' AND object_id = OBJECT_ID('messages'))
        BEGIN
          CREATE INDEX IX_messages_chat_id ON messages(chat_id);
          PRINT 'Created IX_messages_chat_id index'
        END
        
        IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_messages_timestamp' AND object_id = OBJECT_ID('messages'))
        BEGIN
          CREATE INDEX IX_messages_timestamp ON messages(timestamp);
          PRINT 'Created IX_messages_timestamp index'
        END
        
        IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_messages_message_status' AND object_id = OBJECT_ID('messages'))
        BEGIN
          CREATE INDEX IX_messages_message_status ON messages(message_status);
          PRINT 'Created IX_messages_message_status index'
        END
        
        IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_messages_from_number' AND object_id = OBJECT_ID('messages'))
        BEGIN
          CREATE INDEX IX_messages_from_number ON messages(from_number);
          PRINT 'Created IX_messages_from_number index'
        END
        
        IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_messages_to_number' AND object_id = OBJECT_ID('messages'))
        BEGIN
          CREATE INDEX IX_messages_to_number ON messages(to_number);
          PRINT 'Created IX_messages_to_number index'
        END
        
        PRINT 'Messages table updated with reply support and enhanced indexing'
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
          created_at DATETIME DEFAULT GETDATE(),
          updated_at DATETIME DEFAULT GETDATE(),
          is_active BIT DEFAULT 1,
          last_connected DATETIME,
          connection_status VARCHAR(50) DEFAULT 'inactive'
        )
        
        -- Create indexes for sessions
        CREATE INDEX IX_sessions_agent_name ON sessions(agent_name);
        CREATE INDEX IX_sessions_is_active ON sessions(is_active);
        CREATE INDEX IX_sessions_connection_status ON sessions(connection_status);
        
        PRINT 'Sessions table created'
      END
      ELSE
      BEGIN
        -- Add new columns if they don't exist (for existing databases)
        IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.COLUMNS 
                      WHERE TABLE_NAME = 'sessions' AND COLUMN_NAME = 'agent_name')
        BEGIN
          ALTER TABLE sessions ADD agent_name VARCHAR(255) NOT NULL DEFAULT 'Unknown Agent'
          PRINT 'Added agent_name column to sessions'
        END
        
        IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.COLUMNS 
                      WHERE TABLE_NAME = 'sessions' AND COLUMN_NAME = 'updated_at')
        BEGIN
          ALTER TABLE sessions ADD updated_at DATETIME DEFAULT GETDATE()
          PRINT 'Added updated_at column to sessions'
        END
        
        IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.COLUMNS 
                      WHERE TABLE_NAME = 'sessions' AND COLUMN_NAME = 'is_active')
        BEGIN
          ALTER TABLE sessions ADD is_active BIT DEFAULT 1
          PRINT 'Added is_active column to sessions'
        END
        
        IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.COLUMNS 
                      WHERE TABLE_NAME = 'sessions' AND COLUMN_NAME = 'last_connected')
        BEGIN
          ALTER TABLE sessions ADD last_connected DATETIME
          PRINT 'Added last_connected column to sessions'
        END
        
        IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.COLUMNS 
                      WHERE TABLE_NAME = 'sessions' AND COLUMN_NAME = 'connection_status')
        BEGIN
          ALTER TABLE sessions ADD connection_status VARCHAR(50) DEFAULT 'inactive'
          PRINT 'Added connection_status column to sessions'
        END
        
        -- Create missing indexes for sessions
        IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_sessions_agent_name' AND object_id = OBJECT_ID('sessions'))
        BEGIN
          CREATE INDEX IX_sessions_agent_name ON sessions(agent_name);
          PRINT 'Created IX_sessions_agent_name index'
        END
        
        IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_sessions_is_active' AND object_id = OBJECT_ID('sessions'))
        BEGIN
          CREATE INDEX IX_sessions_is_active ON sessions(is_active);
          PRINT 'Created IX_sessions_is_active index'
        END
        
        IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_sessions_connection_status' AND object_id = OBJECT_ID('sessions'))
        BEGIN
          CREATE INDEX IX_sessions_connection_status ON sessions(connection_status);
          PRINT 'Created IX_sessions_connection_status index'
        END
      END
    `);

    // Create enhanced chats table
    await db.request().query(`
      IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'chats')
      BEGIN
        CREATE TABLE chats (
          id INT IDENTITY(1,1) PRIMARY KEY,
          chat_id VARCHAR(255) UNIQUE NOT NULL,
          chat_name NVARCHAR(255),
          chat_type VARCHAR(20) NOT NULL, -- 'individual' or 'group'
          participant_number VARCHAR(50), -- For individual chats
          group_name NVARCHAR(255), -- For group chats
          last_message_id VARCHAR(255),
          last_message_text NVARCHAR(max),
          last_message_time DATETIME,
          last_message_from VARCHAR(50),
          unread_count INT DEFAULT 0,
          is_active BIT DEFAULT 1,
          session_name VARCHAR(255),
          created_at DATETIME DEFAULT GETDATE(),
          updated_at DATETIME DEFAULT GETDATE(),
          -- Enhanced chat metadata
          total_messages INT DEFAULT 0,
          last_reply_id VARCHAR(255), -- Track last reply in this chat
          reply_count INT DEFAULT 0   -- Count of replies in this chat
        )
        
        -- Create indexes for chats
        CREATE INDEX IX_chats_session_name ON chats(session_name);
        CREATE INDEX IX_chats_chat_type ON chats(chat_type);
        CREATE INDEX IX_chats_is_active ON chats(is_active);
        CREATE INDEX IX_chats_last_message_time ON chats(last_message_time);
        CREATE INDEX IX_chats_participant_number ON chats(participant_number);
        
        PRINT 'Chats table created with enhanced features'
      END
      ELSE
      BEGIN
        -- Add new columns if they don't exist
        IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.COLUMNS 
                      WHERE TABLE_NAME = 'chats' AND COLUMN_NAME = 'total_messages')
        BEGIN
          ALTER TABLE chats ADD total_messages INT DEFAULT 0
          PRINT 'Added total_messages column to chats'
        END
        
        IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.COLUMNS 
                      WHERE TABLE_NAME = 'chats' AND COLUMN_NAME = 'last_reply_id')
        BEGIN
          ALTER TABLE chats ADD last_reply_id VARCHAR(255)
          PRINT 'Added last_reply_id column to chats'
        END
        
        IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.COLUMNS 
                      WHERE TABLE_NAME = 'chats' AND COLUMN_NAME = 'reply_count')
        BEGIN
          ALTER TABLE chats ADD reply_count INT DEFAULT 0
          PRINT 'Added reply_count column to chats'
        END
        
        -- Create missing indexes for chats
        IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_chats_session_name' AND object_id = OBJECT_ID('chats'))
        BEGIN
          CREATE INDEX IX_chats_session_name ON chats(session_name);
          PRINT 'Created IX_chats_session_name index'
        END
        
        IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_chats_chat_type' AND object_id = OBJECT_ID('chats'))
        BEGIN
          CREATE INDEX IX_chats_chat_type ON chats(chat_type);
          PRINT 'Created IX_chats_chat_type index'
        END
        
        IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_chats_is_active' AND object_id = OBJECT_ID('chats'))
        BEGIN
          CREATE INDEX IX_chats_is_active ON chats(is_active);
          PRINT 'Created IX_chats_is_active index'
        END
        
        IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_chats_last_message_time' AND object_id = OBJECT_ID('chats'))
        BEGIN
          CREATE INDEX IX_chats_last_message_time ON chats(last_message_time);
          PRINT 'Created IX_chats_last_message_time index'
        END
        
        IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_chats_participant_number' AND object_id = OBJECT_ID('chats'))
        BEGIN
          CREATE INDEX IX_chats_participant_number ON chats(participant_number);
          PRINT 'Created IX_chats_participant_number index'
        END
      END
    `);

    // Create message_analytics table for better reporting
    await db.request().query(`
      IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'message_analytics')
      BEGIN
        CREATE TABLE message_analytics (
          id INT IDENTITY(1,1) PRIMARY KEY,
          session_name VARCHAR(255) NOT NULL,
          date_recorded DATE NOT NULL,
          total_messages INT DEFAULT 0,
          sent_messages INT DEFAULT 0,
          received_messages INT DEFAULT 0,
          reply_messages INT DEFAULT 0,
          media_messages INT DEFAULT 0,
          group_messages INT DEFAULT 0,
          individual_messages INT DEFAULT 0,
          unique_contacts INT DEFAULT 0,
          created_at DATETIME DEFAULT GETDATE(),
          
          UNIQUE(session_name, date_recorded)
        )
        
        CREATE INDEX IX_message_analytics_session_date ON message_analytics(session_name, date_recorded);
        CREATE INDEX IX_message_analytics_date ON message_analytics(date_recorded);
        
        PRINT 'Message analytics table created'
      END
    `);

    // Create triggers to automatically update analytics (optional but useful)
    await db.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.triggers WHERE name = 'tr_messages_analytics_insert')
      BEGIN
        EXEC('
        CREATE TRIGGER tr_messages_analytics_insert
        ON messages
        AFTER INSERT
        AS
        BEGIN
          SET NOCOUNT ON;
          
          DECLARE @session_name VARCHAR(255), @date_recorded DATE, @is_from_me BIT, @is_reply BIT, @has_media BIT, @is_group BIT;
          
          SELECT 
            @session_name = session_name,
            @date_recorded = CAST(created_at AS DATE),
            @is_from_me = is_from_me,
            @is_reply = is_reply,
            @has_media = CASE WHEN media_filename IS NOT NULL THEN 1 ELSE 0 END,
            @is_group = is_group
          FROM inserted;
          
          -- Upsert analytics record
          IF EXISTS (SELECT 1 FROM message_analytics WHERE session_name = @session_name AND date_recorded = @date_recorded)
          BEGIN
            UPDATE message_analytics 
            SET 
              total_messages = total_messages + 1,
              sent_messages = sent_messages + CASE WHEN @is_from_me = 1 THEN 1 ELSE 0 END,
              received_messages = received_messages + CASE WHEN @is_from_me = 0 THEN 1 ELSE 0 END,
              reply_messages = reply_messages + CASE WHEN @is_reply = 1 THEN 1 ELSE 0 END,
              media_messages = media_messages + CASE WHEN @has_media = 1 THEN 1 ELSE 0 END,
              group_messages = group_messages + CASE WHEN @is_group = 1 THEN 1 ELSE 0 END,
              individual_messages = individual_messages + CASE WHEN @is_group = 0 THEN 1 ELSE 0 END
            WHERE session_name = @session_name AND date_recorded = @date_recorded;
          END
          ELSE
          BEGIN
            INSERT INTO message_analytics (
              session_name, date_recorded, total_messages, sent_messages, received_messages,
              reply_messages, media_messages, group_messages, individual_messages
            ) VALUES (
              @session_name, @date_recorded, 1,
              CASE WHEN @is_from_me = 1 THEN 1 ELSE 0 END,
              CASE WHEN @is_from_me = 0 THEN 1 ELSE 0 END,
              CASE WHEN @is_reply = 1 THEN 1 ELSE 0 END,
              CASE WHEN @has_media = 1 THEN 1 ELSE 0 END,
              CASE WHEN @is_group = 1 THEN 1 ELSE 0 END,
              CASE WHEN @is_group = 0 THEN 1 ELSE 0 END
            );
          END
        END
        ')
        
        PRINT 'Analytics trigger created'
      END
    `);

    // Create stored procedures for common queries
    await db.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.procedures WHERE name = 'sp_GetReplyChain')
      BEGIN
        EXEC('
        CREATE PROCEDURE sp_GetReplyChain
          @MessageId VARCHAR(255)
        AS
        BEGIN
          SET NOCOUNT ON;
          
          -- Get the original message
          SELECT * FROM messages WHERE message_id = @MessageId;
          
          -- Get all replies to this message
          WITH ReplyChain AS (
            SELECT *, 1 as Level
            FROM messages 
            WHERE quoted_message_id = @MessageId
            
            UNION ALL
            
            SELECT m.*, rc.Level + 1
            FROM messages m
            INNER JOIN ReplyChain rc ON m.quoted_message_id = rc.message_id
            WHERE rc.Level < 10 -- Prevent infinite recursion
          )
          SELECT * FROM ReplyChain ORDER BY Level, timestamp;
        END
        ')
        
        PRINT 'Reply chain stored procedure created'
      END
    `);

    await db.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.procedures WHERE name = 'sp_GetChatStatistics')
      BEGIN
        EXEC('
        CREATE PROCEDURE sp_GetChatStatistics
          @SessionName VARCHAR(255),
          @ChatId VARCHAR(255) = NULL
        AS
        BEGIN
          SET NOCOUNT ON;
          
          DECLARE @WhereClause NVARCHAR(500) = '' WHERE session_name = @SessionName '';
          
          IF @ChatId IS NOT NULL
            SET @WhereClause = @WhereClause + '' AND chat_id = @ChatId '';
          
          DECLARE @SQL NVARCHAR(2000) = ''
          SELECT 
            COUNT(*) as total_messages,
            SUM(CASE WHEN is_from_me = 1 THEN 1 ELSE 0 END) as sent_count,
            SUM(CASE WHEN is_from_me = 0 THEN 1 ELSE 0 END) as received_count,
            SUM(CASE WHEN is_reply = 1 THEN 1 ELSE 0 END) as reply_count,
            SUM(CASE WHEN media_filename IS NOT NULL THEN 1 ELSE 0 END) as media_count,
            COUNT(DISTINCT participant_phone) as unique_participants,
            MIN(timestamp) as first_message_time,
            MAX(timestamp) as last_message_time
          FROM messages '' + @WhereClause;
          
          EXEC sp_executesql @SQL, N''@SessionName VARCHAR(255), @ChatId VARCHAR(255)'', @SessionName, @ChatId;
        END
        ')
        
        PRINT 'Chat statistics stored procedure created'
      END
    `);

    console.log('✅ Tables ready with enhanced features:');
    console.log('   - Messages table with reply support and participant tracking');
    console.log('   - Sessions table with agent management');
    console.log('   - Chats table with enhanced metadata');
    console.log('   - Message analytics table for reporting');
    console.log('   - Comprehensive indexing for performance');
    console.log('   - Automatic analytics triggers');
    console.log('   - Stored procedures for complex queries');
    
  } catch (error) {
    console.error('❌ Database initialization failed:', error);
    throw error;
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

async function updateOrCreateChat(message, sessionName, participantInfo = null) {
  try {
    // Get participant info if not provided
    if (!participantInfo) {
      participantInfo = await getParticipantInfo(message);
    }

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
      
      // Use participant info for chat name
      chatName = participantInfo.displayName || participantNumber;
    }

    // Check if chat exists
    const existingChat = await db.request()
      .input('chat_id', sql.VarChar, chatId)
      .input('session_name', sql.VarChar, sessionName)
      .query('SELECT id FROM chats WHERE chat_id = @chat_id AND session_name = @session_name');

    const messageText = message.body || `[${message.type.toUpperCase()}]`;
    const messageTime = new Date(message.timestamp * 1000);
    const messageFrom = message.fromMe ? 'You' : (participantInfo.displayName || 'Unknown');

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
        .input('chat_name', sql.NVarChar(sql.MAX), chatName)
        .input('chat_type', sql.VarChar, chatType)
        .input('participant_number', sql.VarChar, participantNumber)
        .input('group_name', sql.NVarChar(sql.MAX), groupName)
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

    console.log(`💬 Chat updated: ${chatName} (${chatType}) - Participant: ${participantInfo.displayName}`);
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
async function getParticipantInfo(message) {
  let participantInfo = {
    phone: null,
    name: null,
    pushname: null,
    displayName: null,
    // New reply fields
    isReply: false,
    quotedMessageId: null,
    quotedMessageBody: null,
    quotedMessageFrom: null,
    quotedMessageType: null,
    quotedMessageTimestamp: null
  };

  try {
    // Determine the participant phone number
    if (message.fromMe) {
      participantInfo.phone = message.to;
    } else {
      participantInfo.phone = message.from;
    }

    // For group messages, extract the actual sender
    if (message.from.includes('@g.us') && !message.fromMe) {
      if (message.author) {
        participantInfo.phone = message.author;
      }
    }

    // Get contact information (existing code)
    if (!message.fromMe) {
      try {
        const contact = await message.getContact();
        if (contact) {
          participantInfo.name = contact.name || contact.verifiedName;
          participantInfo.pushname = contact.pushname;
          participantInfo.displayName = participantInfo.pushname || 
                                       participantInfo.name || 
                                       participantInfo.phone.replace('@c.us', '').replace('@g.us', '');
        }
      } catch (contactError) {
        console.log('Could not get contact info:', contactError.message);
      }
    }

    // CHECK FOR REPLY MESSAGE
    if (message.hasQuotedMsg) {
      participantInfo.isReply = true;
      
      try {
        const quotedMsg = await message.getQuotedMessage();
        if (quotedMsg) {
          participantInfo.quotedMessageId = quotedMsg.id.id;
          participantInfo.quotedMessageBody = quotedMsg.body || `[${quotedMsg.type?.toUpperCase() || 'MEDIA'}]`;
          participantInfo.quotedMessageFrom = quotedMsg.from;
          participantInfo.quotedMessageType = quotedMsg.type;
          participantInfo.quotedMessageTimestamp = quotedMsg.timestamp ? new Date(quotedMsg.timestamp * 1000) : null;
          
          console.log(`💬 Reply detected: "${message.body}" replying to "${participantInfo.quotedMessageBody}"`);
        }
      } catch (quotedError) {
        console.error('Error getting quoted message:', quotedError);
        // Still mark as reply even if we can't get details
        participantInfo.isReply = true;
      }
    }

    // Final fallback for display name
    if (!participantInfo.displayName) {
      participantInfo.displayName = participantInfo.phone.replace('@c.us', '').replace('@g.us', '');
    }

  } catch (error) {
    console.error('Error getting participant info with reply:', error);
    participantInfo.phone = message.fromMe ? message.to : message.from;
    participantInfo.displayName = participantInfo.phone.replace('@c.us', '').replace('@g.us', '');
  }

  return participantInfo;
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

    // Get enhanced participant info including reply details
    const participantInfo = await getParticipantInfo(message);

    let mediaInfo = null;
    if (message.hasMedia) {
      mediaInfo = await downloadMedia(message);
    }

    // Determine chat ID
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
        chat_id, sender_name, timestamp,
        participant_name, participant_phone, contact_pushname,
        is_reply, quoted_message_id, quoted_message_body, 
        quoted_message_from, quoted_message_type, quoted_message_timestamp
      ) VALUES (
        @message_id, @from_number, @to_number, @message_body, 
        @message_type, @is_group, @group_id, @is_from_me, @message_status, 
        @session_name, @media_filename, @media_mimetype, @media_size,
        @chat_id, @sender_name, @timestamp,
        @participant_name, @participant_phone, @contact_pushname,
        @is_reply, @quoted_message_id, @quoted_message_body,
        @quoted_message_from, @quoted_message_type, @quoted_message_timestamp
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
      .input('sender_name', sql.VarChar, participantInfo.displayName)
      .input('timestamp', sql.DateTime, new Date(message.timestamp * 1000))
      .input('participant_name', sql.NVarChar, participantInfo.displayName)
      .input('participant_phone', sql.VarChar, participantInfo.phone)
      .input('contact_pushname', sql.NVarChar, participantInfo.pushname)
      // Reply fields
      .input('is_reply', sql.Bit, participantInfo.isReply)
      .input('quoted_message_id', sql.VarChar, participantInfo.quotedMessageId)
      .input('quoted_message_body', sql.NVarChar(sql.MAX), participantInfo.quotedMessageBody)
      .input('quoted_message_from', sql.VarChar, participantInfo.quotedMessageFrom)
      .input('quoted_message_type', sql.VarChar, participantInfo.quotedMessageType)
      .input('quoted_message_timestamp', sql.DateTime, participantInfo.quotedMessageTimestamp)
      .query(query);

    // Update or create chat entry
    await updateOrCreateChat(message, sessionName, participantInfo);

    // Emit real-time event with reply information
    const direction = message.fromMe ? 'sent' : 'received';
    emitNewMessage(sessionName, message, direction, participantInfo);

    const replyText = participantInfo.isReply ? '(REPLY)' : '';
    const mediaText = mediaInfo ? '(with media)' : '';
    console.log(`✅ ${direction.toUpperCase()} message saved: ${message.id.id} ${replyText} ${mediaText}`);
    console.log(`   From: ${message.from} | To: ${message.to} | Body: ${message.body || '[Media]'}`);
    
    if (participantInfo.isReply) {
      console.log(`   ↳ Replying to: "${participantInfo.quotedMessageBody}"`);
    }

  } catch (error) {
    console.error('❌ Error saving message with reply:', error);
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
async function sendMessage(sessionName, phoneNumber, messageText, mediaPath = null, caption = null, replyToMessageId = null) {
  try {
    const client = activeSessions[sessionName];
    
    if (!client || !isClientReady(sessionName)) {
      throw new Error('Session not ready or not found');
    }

    const formattedNumber = formatPhoneNumber(phoneNumber);
    let sentMessage;
    let options = {};

    // Handle reply functionality
    if (replyToMessageId) {
      try {
        // Find the original message in database to get more context
        const originalMessageResult = await db.request()
          .input('message_id', sql.VarChar, replyToMessageId)
          .input('session_name', sql.VarChar, sessionName)
          .query('SELECT * FROM messages WHERE message_id = @message_id AND session_name = @session_name');

        if (originalMessageResult.recordset.length === 0) {
          throw new Error(`Original message with ID ${replyToMessageId} not found`);
        }

        const originalMessage = originalMessageResult.recordset[0];
        console.log(`📤 Preparing reply to message: ${originalMessage.message_body || '[Media]'}`);

        // Set the quotedMessageId in options
        options.quotedMessageId = replyToMessageId;
        
      } catch (replyError) {
        console.error('Error setting up reply:', replyError);
        throw new Error(`Failed to setup reply: ${replyError.message}`);
      }
    }

    // Send the message based on type
    if (mediaPath && fs.existsSync(mediaPath)) {
      // Send media message with optional reply
      const media = MessageMedia.fromFilePath(mediaPath);
      if (caption) {
        options.caption = caption;
      }
      sentMessage = await client.sendMessage(formattedNumber, media, options);
      console.log(`📤 Media message sent via ${sessionName} to ${formattedNumber}${replyToMessageId ? ' (as reply)' : ''}`);
    } else {
      // Send text message with optional reply
      sentMessage = await client.sendMessage(formattedNumber, messageText, options);
      console.log(`📤 Text message sent via ${sessionName} to ${formattedNumber}: ${messageText}${replyToMessageId ? ' (as reply)' : ''}`);
    }

    // The message will be automatically saved by the message listener
    return {
      success: true,
      messageId: sentMessage.id.id,
      to: formattedNumber,
      body: messageText,
      hasMedia: !!mediaPath,
      isReply: !!replyToMessageId,
      replyToMessageId: replyToMessageId,
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
    const replyType = message.hasQuotedMsg ? '↳ REPLY' : '';
    
    console.log(`${direction} ${chatType} ${replyType} Message:`, {
      id: message.id.id,
      from: message.from,
      to: message.to,
      body: message.body || mediaType,
      type: message.type,
      hasQuotedMsg: message.hasQuotedMsg,
      fromMe: message.fromMe,
      isGroup: isGroup,
      hasMedia: message.hasMedia,
      timestamp: new Date(message.timestamp * 1000).toISOString()
    });
    
    // Save to database with reply information
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
app.post('/send-message/:sessionName', async (req, res) => {
  const sessionName = req.params.sessionName;
  const { phoneNumber, message, caption, replyToMessageId } = req.body;

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
    const result = await sendMessage(sessionName, phoneNumber, message, null, caption, replyToMessageId);
    
    res.json(createResponse(
      true, 
      result, 
      result.isReply ? 'Reply message sent successfully' : 'Message sent successfully'
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

// Enhanced API endpoint for sending media messages with reply support
app.post('/send-media/:sessionName', upload.single('media'), async (req, res) => {
  const sessionName = req.params.sessionName;
  
  const phoneNumber = req.body.phoneNumber;
  const message = req.body?.message;
  const caption = req.body?.caption;
  const replyToMessageId = req.body?.replyToMessageId;
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
    
    const result = await sendMessage(sessionName, phoneNumber, messageText, mediaPath, caption, replyToMessageId);
    
    // Clean up uploaded file
    if (mediaFile && fs.existsSync(mediaFile.path)) {
      fs.unlinkSync(mediaFile.path);
    }
    
    res.json(createResponse(
      true, 
      result, 
      result.isReply ? 'Reply media message sent successfully' : 'Media message sent successfully'
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


// NEW ENDPOINT: Send text message
app.get('/messages/:sessionName', async (req, res) => {
  const sessionName = req.params.sessionName;
  const { limit = 50, offset = 0, type = 'all', participant = null } = req.query;
  
  try {
    let whereClause = 'WHERE session_name = @session_name';
    
    if (type === 'sent') {
      whereClause += ' AND is_from_me = 1';
    } else if (type === 'received') {
      whereClause += ' AND is_from_me = 0';
    }
    
    // Filter by participant if specified
    if (participant) {
      whereClause += ' AND (participant_name LIKE @participant OR participant_phone LIKE @participant)';
    }
    
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
        participant_name,
        participant_phone,
        contact_pushname,
        timestamp,
        created_at
      FROM messages 
      ${whereClause}
      ORDER BY timestamp DESC
      OFFSET @offset ROWS
      FETCH NEXT @limit ROWS ONLY
    `;
    
    const request = db.request()
      .input('session_name', sql.VarChar, sessionName)
      .input('limit', sql.Int, parseInt(limit))
      .input('offset', sql.Int, parseInt(offset));
      
    if (participant) {
      request.input('participant', sql.VarChar, `%${participant}%`);
    }
    
    const result = await request.query(query);
    
    res.json(createResponse(true, result.recordset, `Found ${result.recordset.length} messages`));
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json(createResponse(false, null, 'Error fetching messages'));
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

app.get('/participants/:sessionName', async (req, res) => {
  const sessionName = req.params.sessionName;
  
  try {
    const query = `
      SELECT 
        participant_name,
        participant_phone,
        contact_pushname,
        COUNT(*) as message_count,
        MAX(timestamp) as last_message_time,
        SUM(CASE WHEN is_from_me = 0 THEN 1 ELSE 0 END) as received_count,
        SUM(CASE WHEN is_from_me = 1 THEN 1 ELSE 0 END) as sent_count
      FROM messages 
      WHERE session_name = @session_name 
        AND participant_name IS NOT NULL
      GROUP BY participant_name, participant_phone, contact_pushname
      ORDER BY last_message_time DESC
    `;
    
    const result = await db.request()
      .input('session_name', sql.VarChar, sessionName)
      .query(query);
    
    res.json(createResponse(true, result.recordset, `Found ${result.recordset.length} participants`));
  } catch (error) {
    console.error('Error fetching participants:', error);
    res.status(500).json(createResponse(false, null, 'Error fetching participants'));
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