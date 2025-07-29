const sql = require('mssql');

// Database configuration
const dbConfig = {
  user: 'General@Cyrus',
  password: 'CyrusGeneral@Password',
  server: 'localhost',
  database: 'CyrusGeneral@Password',
  options: {
    encrypt: false,
    trustServerCertificate: true
  }
};

async function runMigration() {
  let db;
  
  try {
    console.log('🔄 Connecting to database...');
    db = await sql.connect(dbConfig);
    console.log('✅ Connected to database');

    // Check if sender_name column exists
    const senderNameCheck = await db.request().query(`
      SELECT COLUMN_NAME 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_NAME = 'messages' AND COLUMN_NAME = 'sender_name'
    `);

    if (senderNameCheck.recordset.length === 0) {
      console.log('➕ Adding sender_name column...');
      await db.request().query(`
        ALTER TABLE messages 
        ADD sender_name VARCHAR(255)
      `);
      console.log('✅ sender_name column added');
    } else {
      console.log('ℹ️ sender_name column already exists');
    }

    // Check if chat_id column exists
    const chatIdCheck = await db.request().query(`
      SELECT COLUMN_NAME 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_NAME = 'messages' AND COLUMN_NAME = 'chat_id'
    `);

    if (chatIdCheck.recordset.length === 0) {
      console.log('➕ Adding chat_id column...');
      await db.request().query(`
        ALTER TABLE messages 
        ADD chat_id VARCHAR(255)
      `);
      console.log('✅ chat_id column added');
    } else {
      console.log('ℹ️ chat_id column already exists');
    }

    // Check if message_body column type is correct (should be NVARCHAR(max))
    const messageBodyCheck = await db.request().query(`
      SELECT DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_NAME = 'messages' AND COLUMN_NAME = 'message_body'
    `);

    if (messageBodyCheck.recordset.length > 0) {
      const columnInfo = messageBodyCheck.recordset[0];
      if (columnInfo.DATA_TYPE === 'text') {
        console.log('🔄 Converting message_body from TEXT to NVARCHAR(max)...');
        await db.request().query(`
          ALTER TABLE messages 
          ALTER COLUMN message_body NVARCHAR(max)
        `);
        console.log('✅ message_body column updated to NVARCHAR(max)');
      } else {
        console.log('ℹ️ message_body column type is already correct');
      }
    }

    // Update existing records to populate chat_id where it's missing
    console.log('🔄 Updating existing records with chat_id...');
    const updateResult = await db.request().query(`
      UPDATE messages 
      SET chat_id = CASE 
        WHEN from_number LIKE '%@g.us' THEN from_number
        WHEN to_number LIKE '%@g.us' THEN to_number
        WHEN is_from_me = 1 THEN to_number
        ELSE from_number
      END
      WHERE chat_id IS NULL
    `);
    console.log(`✅ Updated ${updateResult.rowsAffected[0]} records with chat_id`);

    // Verify the changes
    console.log('🔍 Verifying table structure...');
    const tableStructure = await db.request().query(`
      SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_NAME = 'messages'
      ORDER BY ORDINAL_POSITION
    `);

    console.log('📋 Current messages table structure:');
    tableStructure.recordset.forEach(col => {
      const maxLength = col.CHARACTER_MAXIMUM_LENGTH === -1 ? 'max' : col.CHARACTER_MAXIMUM_LENGTH;
      console.log(`   ${col.COLUMN_NAME}: ${col.DATA_TYPE}${maxLength ? `(${maxLength})` : ''} ${col.IS_NULLABLE === 'YES' ? 'NULL' : 'NOT NULL'}`);
    });

    // Count records
    const countResult = await db.request().query('SELECT COUNT(*) as total FROM messages');
    console.log(`📊 Total messages in database: ${countResult.recordset[0].total}`);

    // Count records with chat_id
    const chatIdCountResult = await db.request().query('SELECT COUNT(*) as total FROM messages WHERE chat_id IS NOT NULL');
    console.log(`📊 Messages with chat_id: ${chatIdCountResult.recordset[0].total}`);

    console.log('✅ Migration completed successfully!');

  } catch (error) {
    console.error('❌ Migration failed:', error);
    throw error;
  } finally {
    if (db) {
      await sql.close();
      console.log('🔒 Database connection closed');
    }
  }
}

// Run migration if this file is executed directly
if (require.main === module) {
  runMigration()
    .then(() => {
      console.log('🎉 Migration script completed!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('💥 Migration script failed:', error);
      process.exit(1);
    });
}

module.exports = { runMigration };