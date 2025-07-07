const express = require('express');
const sql = require('mssql'); // Changed from mysql2 to mssql
const fs = require('fs');
const path = require('path');
const multer = require('multer'); // npm install multer
const mime = require('mime-types'); // npm install mime-types

const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Database configuration - Updated for SQL Server
const dbConfig = {
  user: 'sa',
  password: '123456',
  server: 'localhost', // or IP address
  database: 'whatsapp_tracker',
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
          created_at DATETIME DEFAULT GETDATE()
        )
      END
    `);
    
    console.log('✅ Messages table ready');
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

// ENDPOINTS

// 1. Get all messages sent by a specific number
app.get('/messages/sent-by/:number', async (req, res) => {
  try {
    const { number } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;

    // Get total count
    const countResult = await db.request()
      .input('number', sql.VarChar, number)
      .query('SELECT COUNT(*) as total FROM messages WHERE from_number = @number AND is_from_me = 1');
    
    const total = countResult.recordset[0].total;

    // Get messages
    const messagesResult = await db.request()
      .input('number', sql.VarChar, number)
      .input('limit', sql.Int, limit)
      .input('offset', sql.Int, offset)
      .query(`
        SELECT * FROM messages 
        WHERE from_number = @number AND is_from_me = 1 
        ORDER BY timestamp DESC 
        OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
      `);

    const messages = messagesResult.recordset;
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

// 2. Get all messages sent or received by a specific number
app.get('/messages/by-number/:number', async (req, res) => {
  try {
    const { number } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;

    // Get total count
    const countResult = await db.request()
      .input('number', sql.VarChar, number)
      .query('SELECT COUNT(*) as total FROM messages WHERE from_number = @number OR to_number = @number');
    
    const total = countResult.recordset[0].total;

    // Get messages
    const messagesResult = await db.request()
      .input('number', sql.VarChar, number)
      .input('limit', sql.Int, limit)
      .input('offset', sql.Int, offset)
      .query(`
        SELECT * FROM messages 
        WHERE from_number = @number OR to_number = @number 
        ORDER BY timestamp DESC 
        OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
      `);

    const messages = messagesResult.recordset;
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

// 3. Get chat between two numbers
app.get('/messages/chat/:number1/:number2', async (req, res) => {
  try {
    const { number1, number2 } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;

    // Get total count
    const countResult = await db.request()
      .input('number1', sql.VarChar, number1)
      .input('number2', sql.VarChar, number2)
      .query(`
        SELECT COUNT(*) as total FROM messages 
        WHERE (from_number = @number1 AND to_number = @number2) 
           OR (from_number = @number2 AND to_number = @number1)
      `);
    
    const total = countResult.recordset[0].total;

    // Get messages
    const messagesResult = await db.request()
      .input('number1', sql.VarChar, number1)
      .input('number2', sql.VarChar, number2)
      .input('limit', sql.Int, limit)
      .input('offset', sql.Int, offset)
      .query(`
        SELECT * FROM messages 
        WHERE (from_number = @number1 AND to_number = @number2) 
           OR (from_number = @number2 AND to_number = @number1)
        ORDER BY timestamp ASC 
        OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
      `);

    const messages = messagesResult.recordset;
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

// 7. Get all messages with pagination and filters
app.get('/messages', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;
    const messageType = req.query.type;
    const hasMedia = req.query.hasMedia;
    const isGroup = req.query.isGroup;

    let whereClause = '1=1';
    const request = db.request();

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
- GET  /health - Health check
- GET  /messages - Get all messages (with filters)
- GET  /messages/sent-by/:number - Get messages sent by number
- GET  /messages/by-number/:number - Get all messages for number
- GET  /messages/chat/:number1/:number2 - Get chat between two numbers
- GET  /messages/:messageId - Get message details
- GET  /messages/:messageId/download - Download media file
- GET  /messages/:messageId/view - View media file inline

📝 Query Parameters:
- page, limit - Pagination
- type - Filter by message type
- hasMedia - Filter messages with/without media
- isGroup - Filter group/individual messages
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