const express = require('express');
const sql = require('mssql'); // Changed from mysql2 to mssql
const fs = require('fs');
const path = require('path');
const multer = require('multer'); // npm install multer
const mime = require('mime-types'); // npm install mime-types
const cors = require('cors');

const app = express();

// Middleware
const corsOptions = {
  origin: "*", // In production, specify your frontend URL
  credentials: true,
  optionsSuccessStatus: 200,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
};

app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Database configuration - Updated for SQL Server
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

// Media directory
const mediaDir = path.join(__dirname, 'media');

// Create database connection
let db;
let whatsappClient;

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!fs.existsSync(mediaDir)) {
      fs.mkdirSync(mediaDir, { recursive: true });
    }
    cb(null, mediaDir);
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const extension = path.extname(file.originalname);
    cb(null, `upload_${timestamp}_${file.originalname}`);
  }
});

const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB limit
  }
});

// Initialize database connection
async function initDatabase() {
  try {
    db = await sql.connect(dbConfig);
    console.log('✅ SQL Server connected successfully');
    
    // Create messages table if it doesn't exist
    await db.request().query(`
      IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'messages')
      BEGIN
        CREATE TABLE messages (
          id INT IDENTITY(1,1) PRIMARY KEY,
          message_id VARCHAR(255) UNIQUE,
          from_number VARCHAR(50),
          to_number VARCHAR(50),
          message_body TEXT,
          message_type VARCHAR(20),
          is_group BIT DEFAULT 0,
          group_id VARCHAR(100),
          timestamp DATETIME DEFAULT GETDATE(),
          is_from_me BIT DEFAULT 0,
          message_status VARCHAR(20),
          session_name VARCHAR(255),
          media_url VARCHAR(500),
          media_filename VARCHAR(255),
          media_mimetype VARCHAR(100),
          media_size BIGINT,
          chat_id VARCHAR(255),
          created_at DATETIME DEFAULT GETDATE()
        )
      END
    `);
    
    // Create chats table if it doesn't exist
    await db.request().query(`
      IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'chats')
      BEGIN
        CREATE TABLE chats (
          id INT IDENTITY(1,1) PRIMARY KEY,
          chat_id VARCHAR(255),
          session_name VARCHAR(255),
          chat_name VARCHAR(255),
          chat_type VARCHAR(20), -- 'individual' or 'group'
          participant_number VARCHAR(50),
          group_name VARCHAR(255),
          is_active BIT DEFAULT 1,
          unread_count INT DEFAULT 0,
          last_message_time DATETIME,
          created_at DATETIME DEFAULT GETDATE(),
          updated_at DATETIME DEFAULT GETDATE(),
          UNIQUE(chat_id, session_name)
        )
      END
    `);
    
    console.log('✅ Tables ready');
  } catch (error) {
    console.error('❌ Database connection failed:', error);
    throw error;
  }
}

// Unified response helper
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

// Enhanced MIME type detection
function getMimeType(filename) {
  let mimeType = mime.lookup(filename);
  
  if (!mimeType) {
    const extension = path.extname(filename).toLowerCase();
    const customMimeTypes = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.mp4': 'video/mp4',
      '.webm': 'video/webm',
      '.mp3': 'audio/mpeg',
      '.ogg': 'audio/ogg',
      '.wav': 'audio/wav',
      '.aac': 'audio/aac',
      '.pdf': 'application/pdf',
      '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.txt': 'text/plain',
      '.bin': 'application/octet-stream'
    };
    
    mimeType = customMimeTypes[extension] || 'application/octet-stream';
  }
  
  return mimeType;
}

// Pagination helper
function getPaginationInfo(page, limit, total) {
  const totalPages = Math.ceil(total / limit);
  return {
    currentPage: page,
    totalPages,
    totalItems: total,
    itemsPerPage: limit,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1
  };
}

// SESSION ENDPOINTS

// 1. Get all sessions with statistics
app.get('/sessions', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    const active = req.query.active;

    let whereClause = '1=1';
    const request = db.request();

    if (active !== undefined) {
      // Filter by sessions that have recent activity (messages in last 30 days)
      if (active === 'true') {
        whereClause += ' AND last_message_time >= DATEADD(day, -30, GETDATE())';
      } else {
        whereClause += ' AND (last_message_time < DATEADD(day, -30, GETDATE()) OR last_message_time IS NULL)';
      }
    }

    // Get total count of sessions from the sessions table
    const countResult = await request.query(`
      SELECT COUNT(*) as total 
      FROM sessions s
      LEFT JOIN (
        SELECT 
          session_name,
          MAX(timestamp) as last_message_time
        FROM messages 
        WHERE session_name IS NOT NULL
        GROUP BY session_name
      ) m ON s.session_name = m.session_name
      WHERE ${whereClause}
    `);
    
    const total = countResult.recordset[0].total;

    // Get sessions with statistics - combining sessions table with message stats
    const sessionsResult = await request
      .input('limit', sql.Int, limit)
      .input('offset', sql.Int, offset)
      .query(`
        SELECT 
          s.session_name,
          s.agent_name,
          s.created_at as session_created_at,
          COALESCE(m.total_messages, 0) as total_messages,
          COALESCE(m.sent_messages, 0) as sent_messages,
          COALESCE(m.received_messages, 0) as received_messages,
          COALESCE(m.media_messages, 0) as media_messages,
          COALESCE(m.individual_chats, 0) as individual_chats,
          COALESCE(m.group_chats, 0) as group_chats,
          m.first_message_time,
          m.last_message_time,
          COALESCE(m.active_days, 0) as active_days
        FROM sessions s
        LEFT JOIN (
          SELECT 
            session_name,
            COUNT(*) as total_messages,
            SUM(CASE WHEN is_from_me = 1 THEN 1 ELSE 0 END) as sent_messages,
            SUM(CASE WHEN is_from_me = 0 THEN 1 ELSE 0 END) as received_messages,
            SUM(CASE WHEN media_filename IS NOT NULL THEN 1 ELSE 0 END) as media_messages,
            COUNT(DISTINCT CASE WHEN is_group = 0 THEN 
              CASE WHEN is_from_me = 1 THEN to_number ELSE from_number END 
            END) as individual_chats,
            COUNT(DISTINCT CASE WHEN is_group = 1 THEN group_id END) as group_chats,
            MIN(timestamp) as first_message_time,
            MAX(timestamp) as last_message_time,
            DATEDIFF(day, MIN(timestamp), MAX(timestamp)) + 1 as active_days
          FROM messages 
          WHERE session_name IS NOT NULL
          GROUP BY session_name
        ) m ON s.session_name = m.session_name
        WHERE ${whereClause}
        ORDER BY COALESCE(m.last_message_time, s.created_at) DESC
        OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
      `);

const sessions = sessionsResult.recordset.map(session => ({
  ...session,
  total_chats: (session.individual_chats || 0) + (session.group_chats || 0),
  is_active: session.last_message_time && 
             new Date(session.last_message_time) > new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
}));

    const pagination = getPaginationInfo(page, limit, total);

    res.json(createResponse(
      true,
      sessions,
      `Found ${sessions.length} sessions`,
      pagination
    ));

  } catch (error) {
    console.error('Error fetching sessions:', error);
    res.status(500).json(createResponse(false, null, 'Internal server error'));
  }
});
// 2. Get specific session details
app.get('/sessions/:sessionName', async (req, res) => {
  try {
    const { sessionName } = req.params;

    // Get session statistics
    const sessionResult = await db.request()
      .input('sessionName', sql.VarChar, sessionName)
      .query(`
        SELECT 
          session_name,
          COUNT(*) as total_messages,
          SUM(CASE WHEN is_from_me = 1 THEN 1 ELSE 0 END) as sent_messages,
          SUM(CASE WHEN is_from_me = 0 THEN 1 ELSE 0 END) as received_messages,
          SUM(CASE WHEN media_filename IS NOT NULL THEN 1 ELSE 0 END) as media_messages,
          COUNT(DISTINCT CASE WHEN is_group = 0 THEN 
            CASE WHEN is_from_me = 1 THEN to_number ELSE from_number END 
          END) as individual_chats,
          COUNT(DISTINCT CASE WHEN is_group = 1 THEN group_id END) as group_chats,
          MIN(timestamp) as first_message_time,
          MAX(timestamp) as last_message_time,
          DATEDIFF(day, MIN(timestamp), MAX(timestamp)) + 1 as active_days,
          SUM(ISNULL(media_size, 0)) as total_media_size
        FROM messages 
        WHERE session_name = @sessionName
        GROUP BY session_name
      `);

    if (sessionResult.recordset.length === 0) {
      return res.status(404).json(createResponse(false, null, 'Session not found'));
    }

    const session = sessionResult.recordset[0];
    session.total_chats = (session.individual_chats || 0) + (session.group_chats || 0);
    session.is_active = session.last_message_time && 
                       new Date(session.last_message_time) > new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    // Get media type breakdown
    const mediaBreakdownResult = await db.request()
      .input('sessionName', sql.VarChar, sessionName)
      .query(`
        SELECT 
          CASE 
            WHEN media_mimetype LIKE 'image/%' THEN 'Images'
            WHEN media_mimetype LIKE 'video/%' THEN 'Videos'
            WHEN media_mimetype LIKE 'audio/%' THEN 'Audio'
            WHEN media_mimetype LIKE 'application/pdf' THEN 'Documents'
            ELSE 'Other'
          END as media_category,
          COUNT(*) as count,
          SUM(ISNULL(media_size, 0)) as total_size
        FROM messages 
        WHERE session_name = @sessionName AND media_filename IS NOT NULL
        GROUP BY 
          CASE 
            WHEN media_mimetype LIKE 'image/%' THEN 'Images'
            WHEN media_mimetype LIKE 'video/%' THEN 'Videos'
            WHEN media_mimetype LIKE 'audio/%' THEN 'Audio'
            WHEN media_mimetype LIKE 'application/pdf' THEN 'Documents'
            ELSE 'Other'
          END
        ORDER BY count DESC
      `);

    // Get daily activity for last 30 days
    const activityResult = await db.request()
      .input('sessionName', sql.VarChar, sessionName)
      .query(`
        SELECT 
          CAST(timestamp AS DATE) as date,
          COUNT(*) as message_count,
          SUM(CASE WHEN is_from_me = 1 THEN 1 ELSE 0 END) as sent_count,
          SUM(CASE WHEN is_from_me = 0 THEN 1 ELSE 0 END) as received_count
        FROM messages 
        WHERE session_name = @sessionName
          AND timestamp >= DATEADD(day, -30, GETDATE())
        GROUP BY CAST(timestamp AS DATE)
        ORDER BY date DESC
      `);

    session.media_breakdown = mediaBreakdownResult.recordset;
    session.recent_activity = activityResult.recordset;

    res.json(createResponse(true, session, 'Session details retrieved successfully'));

  } catch (error) {
    console.error('Error fetching session details:', error);
    res.status(500).json(createResponse(false, null, 'Internal server error'));
  }
});

// 3. Get session statistics summary
app.get('/sessions/:sessionName/stats', async (req, res) => {
  try {
    const { sessionName } = req.params;
    const days = parseInt(req.query.days) || 30;

    const statsResult = await db.request()
      .input('sessionName', sql.VarChar, sessionName)
      .input('days', sql.Int, days)
      .query(`
        SELECT 
          COUNT(*) as total_messages,
          SUM(CASE WHEN is_from_me = 1 THEN 1 ELSE 0 END) as sent_messages,
          SUM(CASE WHEN is_from_me = 0 THEN 1 ELSE 0 END) as received_messages,
          SUM(CASE WHEN media_filename IS NOT NULL THEN 1 ELSE 0 END) as media_messages,
          SUM(CASE WHEN is_group = 1 THEN 1 ELSE 0 END) as group_messages,
          COUNT(DISTINCT from_number) as unique_contacts,
          AVG(CAST(LEN(message_body) AS FLOAT)) as avg_message_length,
          SUM(ISNULL(media_size, 0)) as total_media_size
        FROM messages 
        WHERE session_name = @sessionName
          AND timestamp >= DATEADD(day, -@days, GETDATE())
      `);

    // Get hourly distribution
    const hourlyResult = await db.request()
      .input('sessionName', sql.VarChar, sessionName)
      .input('days', sql.Int, days)
      .query(`
        SELECT 
          DATEPART(hour, timestamp) as hour,
          COUNT(*) as message_count
        FROM messages 
        WHERE session_name = @sessionName
          AND timestamp >= DATEADD(day, -@days, GETDATE())
        GROUP BY DATEPART(hour, timestamp)
        ORDER BY hour
      `);

    // Get top contacts
    const topContactsResult = await db.request()
      .input('sessionName', sql.VarChar, sessionName)
      .input('days', sql.Int, days)
      .query(`
        SELECT TOP 10
          CASE WHEN is_from_me = 1 THEN to_number ELSE from_number END as contact,
          COUNT(*) as message_count,
          SUM(CASE WHEN is_from_me = 1 THEN 1 ELSE 0 END) as sent_to_contact,
          SUM(CASE WHEN is_from_me = 0 THEN 1 ELSE 0 END) as received_from_contact
        FROM messages 
        WHERE session_name = @sessionName
          AND timestamp >= DATEADD(day, -@days, GETDATE())
          AND is_group = 0
        GROUP BY CASE WHEN is_from_me = 1 THEN to_number ELSE from_number END
        ORDER BY message_count DESC
      `);

    const stats = {
      overview: statsResult.recordset[0],
      hourly_distribution: hourlyResult.recordset,
      top_contacts: topContactsResult.recordset,
      period_days: days
    };

    res.json(createResponse(true, stats, `Session statistics for last ${days} days`));

  } catch (error) {
    console.error('Error fetching session stats:', error);
    res.status(500).json(createResponse(false, null, 'Internal server error'));
  }
});

// MESSAGE ENDPOINTS (Enhanced with better pagination)

// 1. Get all messages sent by a specific number (Enhanced)
app.get('/messages/sent-by/:number', async (req, res) => {
  try {
    const { number } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100); // Max 100 per page
    const offset = (page - 1) * limit;
    const session = req.query.session;

    let whereClause = 'WHERE from_number = @number AND is_from_me = 1';
    const request = db.request().input('number', sql.VarChar, number);

    if (session) {
      whereClause += ' AND session_name = @session';
      request.input('session', sql.VarChar, session);
    }

    // Get total count
    const countResult = await request.query(`SELECT COUNT(*) as total FROM messages ${whereClause}`);
    const total = countResult.recordset[0].total;

    // Get messages
    const messagesResult = await request
      .input('limit', sql.Int, limit)
      .input('offset', sql.Int, offset)
      .query(`
        SELECT * FROM messages 
        ${whereClause}
        ORDER BY timestamp DESC 
        OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
      `);

    const messages = messagesResult.recordset.map(message => {
      if (message.media_filename) {
        message.downloadUrl = `/messages/${message.message_id}/download`;
        message.viewUrl = `/messages/${message.message_id}/view`;
      }
      return message;
    });

    const pagination = getPaginationInfo(page, limit, total);

    res.json(createResponse(
      true,
      messages,
      `Found ${messages.length} messages sent by ${number}`,
      pagination
    ));

  } catch (error) {
    console.error('Error fetching sent messages:', error);
    res.status(500).json(createResponse(false, null, 'Internal server error'));
  }
});

// 2. Get all messages sent or received by a specific number (Enhanced)
app.get('/messages/by-number/:number', async (req, res) => {
  try {
    const { number } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const offset = (page - 1) * limit;
    const session = req.query.session;
    const hasMedia = req.query.hasMedia;

    let whereClause = 'WHERE (from_number = @number OR to_number = @number)';
    const request = db.request().input('number', sql.VarChar, number);

    if (session) {
      whereClause += ' AND session_name = @session';
      request.input('session', sql.VarChar, session);
    }

    if (hasMedia !== undefined) {
      if (hasMedia === 'true') {
        whereClause += ' AND media_filename IS NOT NULL';
      } else {
        whereClause += ' AND media_filename IS NULL';
      }
    }

    // Get total count
    const countResult = await request.query(`SELECT COUNT(*) as total FROM messages ${whereClause}`);
    const total = countResult.recordset[0].total;

    // Get messages
    const messagesResult = await request
      .input('limit', sql.Int, limit)
      .input('offset', sql.Int, offset)
      .query(`
        SELECT * FROM messages 
        ${whereClause}
        ORDER BY timestamp DESC 
        OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
      `);

    const messages = messagesResult.recordset.map(message => {
      if (message.media_filename) {
        message.downloadUrl = `/messages/${message.message_id}/download`;
        message.viewUrl = `/messages/${message.message_id}/view`;
      }
      return message;
    });

    const pagination = getPaginationInfo(page, limit, total);

    res.json(createResponse(
      true,
      messages,
      `Found ${messages.length} messages for ${number}`,
      pagination
    ));

  } catch (error) {
    console.error('Error fetching messages by number:', error);
    res.status(500).json(createResponse(false, null, 'Internal server error'));
  }
});

// 3. Get chat between two numbers (Enhanced)
app.get('/messages/chat/:number1/:number2', async (req, res) => {
  try {
    const { number1, number2 } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const offset = (page - 1) * limit;
    const session = req.query.session;
    const order = req.query.order || 'desc'; // 'asc' for chronological, 'desc' for latest first

    let whereClause = `WHERE ((from_number = @number1 AND to_number = @number2) 
                            OR (from_number = @number2 AND to_number = @number1))`;
    const request = db.request()
      .input('number1', sql.VarChar, number1)
      .input('number2', sql.VarChar, number2);

    if (session) {
      whereClause += ' AND session_name = @session';
      request.input('session', sql.VarChar, session);
    }

    // Get total count
    const countResult = await request.query(`SELECT COUNT(*) as total FROM messages ${whereClause}`);
    const total = countResult.recordset[0].total;

    // Get messages
    const messagesResult = await request
      .input('limit', sql.Int, limit)
      .input('offset', sql.Int, offset)
      .query(`
        SELECT * FROM messages 
        ${whereClause}
        ORDER BY timestamp ${order.toUpperCase()}
        OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
      `);

    const messages = messagesResult.recordset.map(message => {
      if (message.media_filename) {
        message.downloadUrl = `/messages/${message.message_id}/download`;
        message.viewUrl = `/messages/${message.message_id}/view`;
      }
      return message;
    });

    const pagination = getPaginationInfo(page, limit, total);

    res.json(createResponse(
      true,
      messages,
      `Found ${messages.length} messages in chat between ${number1} and ${number2}`,
      pagination
    ));

  } catch (error) {
    console.error('Error fetching chat messages:', error);
    res.status(500).json(createResponse(false, null, 'Internal server error'));
  }
});

// 4. Download file by message ID
app.get('/messages/:messageId/download', async (req, res) => {
  try {
    const { messageId } = req.params;

    // Get message info from database
    const messagesResult = await db.request()
      .input('messageId', sql.VarChar, messageId)
      .query('SELECT * FROM messages WHERE message_id = @messageId AND media_filename IS NOT NULL');

    if (messagesResult.recordset.length === 0) {
      return res.status(404).json(createResponse(false, null, 'Message not found or has no media'));
    }

    const message = messagesResult.recordset[0];
    const filename = message.media_filename;
    const filepath = path.join(mediaDir, filename);

    // Security check: prevent directory traversal
    if (!filepath.startsWith(mediaDir)) {
      return res.status(400).json(createResponse(false, null, 'Invalid filename'));
    }

    // Check if file exists
    if (!fs.existsSync(filepath)) {
      return res.status(404).json(createResponse(false, null, 'Media file not found on disk'));
    }

    // Get file stats
    const stats = fs.statSync(filepath);
    const mimeType = message.media_mimetype || getMimeType(filename);
    
    // Determine original filename for download
    const originalName = filename.includes('_') ? 
      filename.split('_').slice(2).join('_') : filename;

    // Set headers for download
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', stats.size);
    res.setHeader('Content-Disposition', `attachment; filename="${originalName}"`);
    res.setHeader('X-Message-ID', messageId);
    res.setHeader('X-Original-Filename', originalName);
    res.setHeader('X-File-Size', stats.size.toString());
    res.setHeader('X-MIME-Type', mimeType);

    // Create read stream and pipe to response
    const fileStream = fs.createReadStream(filepath);
    fileStream.pipe(res);

    fileStream.on('error', (err) => {
      console.error('Error streaming file:', err);
      if (!res.headersSent) {
        res.status(500).json(createResponse(false, null, 'Error downloading file'));
      }
    });

  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json(createResponse(false, null, 'Internal server error'));
  }
});

// 5. Get message details by ID
app.get('/messages/:messageId', async (req, res) => {
  try {
    const { messageId } = req.params;

    const messagesResult = await db.request()
      .input('messageId', sql.VarChar, messageId)
      .query('SELECT * FROM messages WHERE message_id = @messageId');

    if (messagesResult.recordset.length === 0) {
      return res.status(404).json(createResponse(false, null, 'Message not found'));
    }

    const message = messagesResult.recordset[0];

    // Add download URL if message has media
    if (message.media_filename) {
      message.downloadUrl = `/messages/${messageId}/download`;
      message.viewUrl = `/messages/${messageId}/view`;
    }

    res.json(createResponse(true, message, 'Message retrieved successfully'));

  } catch (error) {
    console.error('Error fetching message:', error);
    res.status(500).json(createResponse(false, null, 'Internal server error'));
  }
});

// 6. View file inline (for images, videos, etc.)
app.get('/messages/:messageId/view', async (req, res) => {
  try {
    const { messageId } = req.params;

    // Get message info from database
    const messagesResult = await db.request()
      .input('messageId', sql.VarChar, messageId)
      .query('SELECT * FROM messages WHERE message_id = @messageId AND media_filename IS NOT NULL');

    if (messagesResult.recordset.length === 0) {
      return res.status(404).json(createResponse(false, null, 'Message not found or has no media'));
    }

    const message = messagesResult.recordset[0];
    const filename = message.media_filename;
    const filepath = path.join(mediaDir, filename);

    if (!fs.existsSync(filepath)) {
      return res.status(404).json(createResponse(false, null, 'Media file not found on disk'));
    }

    const stats = fs.statSync(filepath);
    const mimeType = message.media_mimetype || getMimeType(filename);

    // Set headers for inline viewing
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', stats.size);
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);

    // Stream file
    const fileStream = fs.createReadStream(filepath);
    fileStream.pipe(res);

    fileStream.on('error', (err) => {
      console.error('Error streaming file:', err);
      if (!res.headersSent) {
        res.status(500).json(createResponse(false, null, 'Error viewing file'));
      }
    });

  } catch (error) {
    console.error('View error:', error);
    res.status(500).json(createResponse(false, null, 'Internal server error'));
  }
});

// 7. Get all messages with enhanced pagination and filters
app.get('/messages', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100); // Max 100 per page
    const offset = (page - 1) * limit;
    const messageType = req.query.type;
    const hasMedia = req.query.hasMedia;
    const isGroup = req.query.isGroup;
    const session = req.query.session;
    const fromDate = req.query.fromDate;
    const toDate = req.query.toDate;
    const search = req.query.search;

    let whereClause = '1=1';
    const request = db.request();

    if (session) {
      whereClause += ' AND session_name = @session';
      request.input('session', sql.VarChar, session);
    }

    if (messageType) {
      whereClause += ' AND message_type = @messageType';
      request.input('messageType', sql.VarChar, messageType);
    }

    if (hasMedia !== undefined) {
      if (hasMedia === 'true') {
        whereClause += ' AND media_filename IS NOT NULL';
      } else {
        whereClause += ' AND media_filename IS NULL';
      }
    }

    if (isGroup !== undefined) {
      whereClause += ' AND is_group = @isGroup';
      request.input('isGroup', sql.Bit, isGroup === 'true');
    }

    if (fromDate) {
      whereClause += ' AND timestamp >= @fromDate';
      request.input('fromDate', sql.DateTime, new Date(fromDate));
    }

    if (toDate) {
      whereClause += ' AND timestamp <= @toDate';
      request.input('toDate', sql.DateTime, new Date(toDate));
    }

    if (search) {
      whereClause += ' AND (message_body LIKE @search OR from_number LIKE @search OR to_number LIKE @search)';
      request.input('search', sql.VarChar, `%${search}%`);
    }

    // Get total count
    const countResult = await request.query(
      `SELECT COUNT(*) as total FROM messages WHERE ${whereClause}`
    );
    const total = countResult.recordset[0].total;

    // Get messages
    const messagesResult = await request
      .input('limit', sql.Int, limit)
      .input('offset', sql.Int, offset)
      .query(`
        SELECT * FROM messages 
        WHERE ${whereClause}
        ORDER BY timestamp DESC 
        OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
      `);

    const messages = messagesResult.recordset;

    // Add download URLs for messages with media
    const messagesWithUrls = messages.map(message => {
      if (message.media_filename) {
        message.downloadUrl = `/messages/${message.message_id}/download`;
        message.viewUrl = `/messages/${message.message_id}/view`;
      }
      return message;
    });

    const pagination = getPaginationInfo(page, limit, total);

    res.json(createResponse(
      true,
      messagesWithUrls,
      `Found ${messages.length} messages`,
      pagination
    ));

  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json(createResponse(false, null, 'Internal server error'));
  }
});

// 8. Search messages across all sessions
app.get('/messages/search', async (req, res) => {
  try {
    const { query: searchQuery, session, type, hasMedia } = req.query;
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 20, 50); // Lower limit for search
    const offset = (page - 1) * limit;

    if (!searchQuery || searchQuery.trim().length < 2) {
      return res.status(400).json(createResponse(false, null, 'Search query must be at least 2 characters'));
    }

    let whereClause = 'WHERE (message_body LIKE @searchQuery OR from_number LIKE @searchQuery OR to_number LIKE @searchQuery)';
    const request = db.request()
      .input('searchQuery', sql.VarChar, `%${searchQuery}%`);

    if (session) {
      whereClause += ' AND session_name = @session';
      request.input('session', sql.VarChar, session);
    }

    if (type) {
      whereClause += ' AND message_type = @type';
      request.input('type', sql.VarChar, type);
    }

    if (hasMedia !== undefined) {
      if (hasMedia === 'true') {
        whereClause += ' AND media_filename IS NOT NULL';
      } else {
        whereClause += ' AND media_filename IS NULL';
      }
    }

    // Get total count
    const countResult = await request.query(
      `SELECT COUNT(*) as total FROM messages ${whereClause}`
    );
    const total = countResult.recordset[0].total;

    // Get messages
    const messagesResult = await request
      .input('limit', sql.Int, limit)
      .input('offset', sql.Int, offset)
      .query(`
        SELECT * FROM messages 
        ${whereClause}
        ORDER BY timestamp DESC
        OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
      `);

    const messages = messagesResult.recordset.map(message => {
      if (message.media_filename) {
        message.downloadUrl = `/messages/${message.message_id}/download`;
        message.viewUrl = `/messages/${message.message_id}/view`;
      }
      return message;
    });

    const pagination = getPaginationInfo(page, limit, total);

    res.json(createResponse(
      true,
      messages,
      `Found ${messages.length} messages matching "${searchQuery}"`,
      pagination
    ));

  } catch (error) {
    console.error('Error searching messages:', error);
    res.status(500).json(createResponse(false, null, 'Internal server error'));
  }
});

// CHAT ENDPOINTS

// 1. Get all chats for a session
app.get('/chats/:sessionName', async (req, res) => {
  try {
    const { sessionName } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;
    const chatType = req.query.type; // 'individual' or 'group'
    const isActive = req.query.active;

    let whereClause = 'WHERE session_name = @sessionName';
    const request = db.request().input('sessionName', sql.VarChar, sessionName);

    if (chatType) {
      whereClause += ' AND chat_type = @chatType';
      request.input('chatType', sql.VarChar, chatType);
    }

    if (isActive !== undefined) {
      whereClause += ' AND is_active = @isActive';
      request.input('isActive', sql.Bit, isActive === 'true');
    }

    // Get total count
    const countResult = await request.query(
      `SELECT COUNT(*) as total FROM chats ${whereClause}`
    );
    const total = countResult.recordset[0].total;

    // Get chats
    const chatsResult = await request
      .input('limit', sql.Int, limit)
      .input('offset', sql.Int, offset)
      .query(`
        SELECT 
          c.*,
          (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.chat_id AND m.session_name = c.session_name) as total_messages,
          (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.chat_id AND m.session_name = c.session_name AND m.is_from_me = 0) as received_messages,
          (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.chat_id AND m.session_name = c.session_name AND m.is_from_me = 1) as sent_messages
        FROM chats c
        ${whereClause}
        ORDER BY c.last_message_time DESC
        OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
      `);

    const chats = chatsResult.recordset;
    const pagination = getPaginationInfo(page, limit, total);

    res.json(createResponse(
      true,
      chats,
      `Found ${chats.length} chats for session ${sessionName}`,
      pagination
    ));

  } catch (error) {
    console.error('Error fetching chats:', error);
    res.status(500).json(createResponse(false, null, 'Internal server error'));
  }
});

// 2. Get all chats (across all sessions)
app.get('/chats', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;
    const chatType = req.query.type;
    const isActive = req.query.active;
    const sessionName = req.query.session;

    let whereClause = '1=1';
    const request = db.request();

    if (sessionName) {
      whereClause += ' AND session_name = @sessionName';
      request.input('sessionName', sql.VarChar, sessionName);
    }

    if (chatType) {
      whereClause += ' AND chat_type = @chatType';
      request.input('chatType', sql.VarChar, chatType);
    }

    if (isActive !== undefined) {
      whereClause += ' AND is_active = @isActive';
      request.input('isActive', sql.Bit, isActive === 'true');
    }

    // Get total count
    const countResult = await request.query(
      `SELECT COUNT(*) as total FROM chats WHERE ${whereClause}`
    );
    const total = countResult.recordset[0].total;

    // Get chats
    const chatsResult = await request
      .input('limit', sql.Int, limit)
      .input('offset', sql.Int, offset)
      .query(`
        SELECT 
          c.*,
          (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.chat_id AND m.session_name = c.session_name) as total_messages,
          (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.chat_id AND m.session_name = c.session_name AND m.is_from_me = 0) as received_messages,
          (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.chat_id AND m.session_name = c.session_name AND m.is_from_me = 1) as sent_messages
        FROM chats c
        WHERE ${whereClause}
        ORDER BY c.last_message_time DESC
        OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
      `);

    const chats = chatsResult.recordset;
    const pagination = getPaginationInfo(page, limit, total);

    res.json(createResponse(
      true,
      chats,
      `Found ${chats.length} chats`,
      pagination
    ));

  } catch (error) {
    console.error('Error fetching chats:', error);
    res.status(500).json(createResponse(false, null, 'Internal server error'));
  }
});

// 3. Get specific chat details
app.get('/chats/:sessionName/:chatId', async (req, res) => {
  try {
    const { sessionName, chatId } = req.params;

    const chatResult = await db.request()
      .input('sessionName', sql.VarChar, sessionName)
      .input('chatId', sql.VarChar, decodeURIComponent(chatId))
      .query(`
        SELECT 
          c.*,
          (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.chat_id AND m.session_name = c.session_name) as total_messages,
          (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.chat_id AND m.session_name = c.session_name AND m.is_from_me = 0) as received_messages,
          (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.chat_id AND m.session_name = c.session_name AND m.is_from_me = 1) as sent_messages,
          (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.chat_id AND m.session_name = c.session_name AND m.media_filename IS NOT NULL) as media_messages
        FROM chats c
        WHERE c.session_name = @sessionName AND c.chat_id = @chatId
        ORDER BY c.id DESC
      `);
    if (chatResult.recordset.length === 0) {
      return res.status(404).json(createResponse(false, null, 'Chat not found'));
    }

    const chat = chatResult.recordset[0];
    res.json(createResponse(true, chat, 'Chat retrieved successfully'));

  } catch (error) {
    console.error('Error fetching chat:', error);
    res.status(500).json(createResponse(false, null, 'Internal server error'));
  }
});

// 4. Get messages for a specific chat
app.get('/chats/:sessionName/:chatId/messages', async (req, res) => {
  try {
    const { sessionName, chatId } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;
    const hasMedia = req.query.hasMedia;
    const messageType = req.query.type;

    let whereClause = 'WHERE session_name = @sessionName AND chat_id = @chatId';
    const request = db.request()
      .input('sessionName', sql.VarChar, sessionName)
      .input('chatId', sql.VarChar, decodeURIComponent(chatId));

    if (hasMedia !== undefined) {
      if (hasMedia === 'true') {
        whereClause += ' AND media_filename IS NOT NULL';
      } else {
        whereClause += ' AND media_filename IS NULL';
      }
    }

    if (messageType) {
      whereClause += ' AND message_type = @messageType';
      request.input('messageType', sql.VarChar, messageType);
    }

    // Get total count
    const countResult = await request.query(
      `SELECT COUNT(*) as total FROM messages ${whereClause}`
    );
    const total = countResult.recordset[0].total;

    // Get messages
    const messagesResult = await request
      .input('limit', sql.Int, limit)
      .input('offset', sql.Int, offset)
      .query(`
        SELECT * FROM messages 
        ${whereClause}
        ORDER BY timestamp DESC
        OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
      `);

    const messages = messagesResult.recordset;

    // Add download URLs for messages with media
    const messagesWithUrls = messages.map(message => {
      if (message.media_filename) {
        message.downloadUrl = `/messages/${message.message_id}/download`;
        message.viewUrl = `/messages/${message.message_id}/view`;
      }
      return message;
    });

    const pagination = getPaginationInfo(page, limit, total);

    res.json(createResponse(
      true,
      messagesWithUrls,
      `Found ${messages.length} messages for chat`,
      pagination
    ));

  } catch (error) {
    console.error('Error fetching chat messages:', error);
    res.status(500).json(createResponse(false, null, 'Internal server error'));
  }
});

// 5. Get chat statistics
app.get('/chats/:sessionName/:chatId/stats', async (req, res) => {
  try {
    const { sessionName, chatId } = req.params;

    const statsResult = await db.request()
      .input('sessionName', sql.VarChar, sessionName)
      .input('chatId', sql.VarChar, decodeURIComponent(chatId))
      .query(`
        SELECT 
          COUNT(*) as total_messages,
          SUM(CASE WHEN is_from_me = 1 THEN 1 ELSE 0 END) as sent_messages,
          SUM(CASE WHEN is_from_me = 0 THEN 1 ELSE 0 END) as received_messages,
          SUM(CASE WHEN media_filename IS NOT NULL THEN 1 ELSE 0 END) as media_messages,
          SUM(CASE WHEN is_group = 1 THEN 1 ELSE 0 END) as group_messages,
          MIN(timestamp) as first_message_time,
          MAX(timestamp) as last_message_time,
          COUNT(DISTINCT CASE WHEN is_from_me = 0 THEN from_number END) as unique_senders
        FROM messages 
        WHERE session_name = @sessionName AND chat_id = @chatId
      `);

    // Get media breakdown
    const mediaStatsResult = await db.request()
      .input('sessionName', sql.VarChar, sessionName)
      .input('chatId', sql.VarChar, decodeURIComponent(chatId))
      .query(`
        SELECT 
          media_mimetype,
          COUNT(*) as count,
          SUM(media_size) as total_size
        FROM messages 
        WHERE session_name = @sessionName AND chat_id = @chatId AND media_filename IS NOT NULL
        GROUP BY media_mimetype
        ORDER BY count DESC
      `);

    // Get daily message counts (last 30 days)
    const dailyStatsResult = await db.request()
      .input('sessionName', sql.VarChar, sessionName)
      .input('chatId', sql.VarChar, decodeURIComponent(chatId))
      .query(`
        SELECT 
          CAST(timestamp AS DATE) as date,
          COUNT(*) as message_count,
          SUM(CASE WHEN is_from_me = 1 THEN 1 ELSE 0 END) as sent_count,
          SUM(CASE WHEN is_from_me = 0 THEN 1 ELSE 0 END) as received_count
        FROM messages 
        WHERE session_name = @sessionName AND chat_id = @chatId
          AND timestamp >= DATEADD(day, -30, GETDATE())
        GROUP BY CAST(timestamp AS DATE)
        ORDER BY date DESC
      `);

    const stats = statsResult.recordset[0];
    const mediaStats = mediaStatsResult.recordset;
    const dailyStats = dailyStatsResult.recordset;

    res.json(createResponse(
      true,
      {
        overview: stats,
        media_breakdown: mediaStats,
        daily_activity: dailyStats
      },
      'Chat statistics retrieved successfully'
    ));

  } catch (error) {
    console.error('Error fetching chat stats:', error);
    res.status(500).json(createResponse(false, null, 'Internal server error'));
  }
});

// 6. Search chats
app.get('/chats/search', async (req, res) => {
  try {
    const { query: searchQuery, session, type } = req.query;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    if (!searchQuery || searchQuery.trim().length < 2) {
      return res.status(400).json(createResponse(false, null, 'Search query must be at least 2 characters'));
    }

    let whereClause = 'WHERE (chat_name LIKE @searchQuery OR participant_number LIKE @searchQuery OR group_name LIKE @searchQuery)';
    const request = db.request()
      .input('searchQuery', sql.VarChar, `%${searchQuery}%`);

    if (session) {
      whereClause += ' AND session_name = @session';
      request.input('session', sql.VarChar, session);
    }

    if (type) {
      whereClause += ' AND chat_type = @type';
      request.input('type', sql.VarChar, type);
    }

    // Get total count
    const countResult = await request.query(
      `SELECT COUNT(*) as total FROM chats ${whereClause}`
    );
    const total = countResult.recordset[0].total;

    // Get chats
    const chatsResult = await request
      .input('limit', sql.Int, limit)
      .input('offset', sql.Int, offset)
      .query(`
        SELECT 
          c.*,
          (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.chat_id AND m.session_name = c.session_name) as total_messages
        FROM chats c
        ${whereClause}
        ORDER BY c.last_message_time DESC
        OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
      `);

    const chats = chatsResult.recordset;
    const pagination = getPaginationInfo(page, limit, total);

    res.json(createResponse(
      true,
      chats,
      `Found ${chats.length} chats matching "${searchQuery}"`,
      pagination
    ));

  } catch (error) {
    console.error('Error searching chats:', error);
    res.status(500).json(createResponse(false, null, 'Internal server error'));
  }
});

// 7. Update chat (mark as read, archive, etc.)
app.put('/chats/:sessionName/:chatId', async (req, res) => {
  try {
    const { sessionName, chatId } = req.params;
    const { is_active, unread_count, chat_name } = req.body;

    const updateFields = [];
    const request = db.request()
      .input('sessionName', sql.VarChar, sessionName)
      .input('chatId', sql.VarChar, decodeURIComponent(chatId));

    if (is_active !== undefined) {
      updateFields.push('is_active = @is_active');
      request.input('is_active', sql.Bit, is_active);
    }

    if (unread_count !== undefined) {
      updateFields.push('unread_count = @unread_count');
      request.input('unread_count', sql.Int, unread_count);
    }

    if (chat_name !== undefined) {
      updateFields.push('chat_name = @chat_name');
      request.input('chat_name', sql.VarChar, chat_name);
    }

    if (updateFields.length === 0) {
      return res.status(400).json(createResponse(false, null, 'No valid fields to update'));
    }

    updateFields.push('updated_at = GETDATE()');

    const result = await request.query(`
      UPDATE chats 
      SET ${updateFields.join(', ')}
      WHERE session_name = @sessionName AND chat_id = @chatId
    `);

    if (result.rowsAffected[0] === 0) {
      return res.status(404).json(createResponse(false, null, 'Chat not found'));
    }

    res.json(createResponse(true, null, 'Chat updated successfully'));

  } catch (error) {
    console.error('Error updating chat:', error);
    res.status(500).json(createResponse(false, null, 'Internal server error'));
  }
});

// 8. Health check endpoint
app.get('/health', async (req, res) => {
  try {
    // Check database connection
    await db.request().query('SELECT 1');
    
    // Check WhatsApp client status
    const whatsappStatus = whatsappClient ? 'connected' : 'disconnected';
    
    res.json(createResponse(
      true,
      {
        database: 'connected',
        whatsapp: whatsappStatus,
        mediaDirectory: fs.existsSync(mediaDir) ? 'exists' : 'missing',
        server: 'running'
      },
      'Service health check'
    ));

  } catch (error) {
    console.error('Health check error:', error);
    res.status(500).json(createResponse(false, null, 'Service unhealthy'));
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json(createResponse(false, null, 'Internal server error'));
});

// 404 handler
app.use((req, res) => {
  res.status(404).json(createResponse(false, null, 'Endpoint not found'));
});

// Initialize and start server
async function startServer() {
  try {
    console.log('🚀 Starting WhatsApp Tracker API Server...');
    
    // Initialize database
    await initDatabase();
    
    // Start server
    const PORT = process.env.PORT || 3001;
    app.listen(PORT, () => {
      console.log(`✅ API Server running on http://localhost:${PORT}`);
      console.log(`📁 Media directory: ${mediaDir}`);
      console.log(`
📋 Available Endpoints:

🔍 SESSIONS:
- GET  /sessions - Get all sessions with statistics
- GET  /sessions/:sessionName - Get specific session details
- GET  /sessions/:sessionName/stats - Get session statistics

💬 MESSAGES:
- GET  /messages - Get all messages (with enhanced filters)
- GET  /messages/search - Search messages across all sessions
- GET  /messages/sent-by/:number - Get messages sent by number
- GET  /messages/by-number/:number - Get all messages for number
- GET  /messages/chat/:number1/:number2 - Get chat between two numbers
- GET  /messages/:messageId - Get message details
- GET  /messages/:messageId/download - Download media file
- GET  /messages/:messageId/view - View media file inline

💭 CHATS:
- GET  /chats - Get all chats (with filters)
- GET  /chats/search - Search chats by name/number
- GET  /chats/:sessionName - Get chats for specific session
- GET  /chats/:sessionName/:chatId - Get specific chat details
- GET  /chats/:sessionName/:chatId/messages - Get messages for chat
- GET  /chats/:sessionName/:chatId/stats - Get chat statistics
- PUT  /chats/:sessionName/:chatId - Update chat properties

🏥 SYSTEM:
- GET  /health - Health check

📝 Enhanced Query Parameters:
- page, limit - Pagination (max 100 items per page for messages)
- session - Filter by session name
- type - Filter by message/chat type
- hasMedia - Filter messages with/without media (true/false)
- isGroup - Filter group/individual messages (true/false)
- active - Filter active/inactive items (true/false)
- fromDate, toDate - Date range filter (YYYY-MM-DD)
- search - Text search in message body/numbers
- order - Sort order for chat messages (asc/desc)
- days - Number of days for statistics (default: 30)

📊 New Features:
✅ Session management with comprehensive statistics
✅ Enhanced pagination with max limits
✅ Advanced search capabilities
✅ Date range filtering
✅ Media type breakdowns
✅ Activity analytics
✅ Better error handling
      `);
    });
    
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  
  if (whatsappClient) {
    try {
      await whatsappClient.close();
    } catch (error) {
      console.error('Error closing WhatsApp client:', error);
    }
  }
  
  if (db) {
    try {
      await sql.close();
    } catch (error) {
      console.error('Error closing database connection:', error);
    }
  }
  
  console.log('✅ Shutdown complete');
  process.exit(0);
});

// Start the server
if (require.main === module) {
  startServer().catch(console.error);
}

module.exports = app;