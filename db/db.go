package db

import (
	"database/sql"
	"log"
	"os"

	_ "github.com/mattn/go-sqlite3"
)

var DB *sql.DB

func Init() {
	dbPath := os.Getenv("DB_PATH")
	if dbPath == "" {
		dbPath = "./shopping.db"
	}

	var err error
	DB, err = sql.Open("sqlite3", dbPath+"?_foreign_keys=on")
	if err != nil {
		log.Fatal("Failed to connect to database:", err)
	}

	// Test connection
	if err = DB.Ping(); err != nil {
		log.Fatal("Failed to ping database:", err)
	}

	// Create tables
	createTables()

	log.Println("Database initialized successfully")
}

func createTables() {
	schema := `
	CREATE TABLE IF NOT EXISTS sections (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		name TEXT NOT NULL,
		sort_order INTEGER NOT NULL,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at INTEGER DEFAULT (strftime('%s', 'now'))
	);

	CREATE TABLE IF NOT EXISTS items (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		section_id INTEGER NOT NULL,
		name TEXT NOT NULL,
		description TEXT DEFAULT '',
		completed BOOLEAN DEFAULT FALSE,
		uncertain BOOLEAN DEFAULT FALSE,
		sort_order INTEGER NOT NULL,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at INTEGER DEFAULT (strftime('%s', 'now')),
		FOREIGN KEY (section_id) REFERENCES sections(id) ON DELETE CASCADE
	);

	CREATE TABLE IF NOT EXISTS sessions (
		id TEXT PRIMARY KEY,
		expires_at INTEGER NOT NULL
	);

	CREATE INDEX IF NOT EXISTS idx_items_section ON items(section_id, sort_order);
	CREATE INDEX IF NOT EXISTS idx_sections_order ON sections(sort_order);
	`

	_, err := DB.Exec(schema)
	if err != nil {
		log.Fatal("Failed to create tables:", err)
	}

	// Migration: Add updated_at column if it doesn't exist
	runMigrations()
}

func runMigrations() {
	// Check if updated_at column exists in sections
	var count int
	err := DB.QueryRow("SELECT COUNT(*) FROM pragma_table_info('sections') WHERE name='updated_at'").Scan(&count)
	if err != nil {
		log.Println("Migration check failed:", err)
		return
	}

	if count == 0 {
		log.Println("Running migration: Adding updated_at to sections...")
		_, err := DB.Exec("ALTER TABLE sections ADD COLUMN updated_at INTEGER DEFAULT (strftime('%s', 'now'))")
		if err != nil {
			log.Println("Migration failed for sections:", err)
		} else {
			// Set updated_at for existing rows
			DB.Exec("UPDATE sections SET updated_at = strftime('%s', 'now') WHERE updated_at IS NULL")
			log.Println("Migration completed: sections.updated_at added")
		}
	}

	// Check if updated_at column exists in items
	err = DB.QueryRow("SELECT COUNT(*) FROM pragma_table_info('items') WHERE name='updated_at'").Scan(&count)
	if err != nil {
		log.Println("Migration check failed:", err)
		return
	}

	if count == 0 {
		log.Println("Running migration: Adding updated_at to items...")
		_, err := DB.Exec("ALTER TABLE items ADD COLUMN updated_at INTEGER DEFAULT (strftime('%s', 'now'))")
		if err != nil {
			log.Println("Migration failed for items:", err)
		} else {
			// Set updated_at for existing rows
			DB.Exec("UPDATE items SET updated_at = strftime('%s', 'now') WHERE updated_at IS NULL")
			log.Println("Migration completed: items.updated_at added")
		}
	}
}

func Close() {
	if DB != nil {
		DB.Close()
	}
}
