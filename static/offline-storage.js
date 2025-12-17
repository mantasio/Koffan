// Koffan Offline Storage - IndexedDB wrapper
class OfflineStorage {
    constructor() {
        this.dbName = 'koffan-offline';
        this.dbVersion = 1;
        this.db = null;
    }

    async init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);

            request.onerror = () => {
                console.error('[OfflineStorage] Failed to open database:', request.error);
                reject(request.error);
            };

            request.onsuccess = () => {
                this.db = request.result;
                console.log('[OfflineStorage] Database opened successfully');
                resolve(this.db);
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                console.log('[OfflineStorage] Upgrading database...');

                // Sections cache store
                if (!db.objectStoreNames.contains('sections')) {
                    const sectionsStore = db.createObjectStore('sections', { keyPath: 'id' });
                    sectionsStore.createIndex('sort_order', 'sort_order');
                }

                // Offline queue store
                if (!db.objectStoreNames.contains('offline_queue')) {
                    const queueStore = db.createObjectStore('offline_queue', {
                        keyPath: 'id',
                        autoIncrement: true
                    });
                    queueStore.createIndex('timestamp', 'timestamp');
                }

                // Sync metadata store
                if (!db.objectStoreNames.contains('sync_metadata')) {
                    db.createObjectStore('sync_metadata', { keyPath: 'key' });
                }
            };
        });
    }

    // ===== OFFLINE QUEUE METHODS =====

    async queueAction(action) {
        if (!this.db) await this.init();

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('offline_queue', 'readwrite');
            const store = tx.objectStore('offline_queue');

            const request = store.add({
                ...action,
                timestamp: Date.now()
            });

            request.onsuccess = () => {
                console.log('[OfflineStorage] Action queued:', action.type);
                resolve(request.result);
            };
            request.onerror = () => reject(request.error);
        });
    }

    async getQueuedActions() {
        if (!this.db) await this.init();

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('offline_queue', 'readonly');
            const store = tx.objectStore('offline_queue');
            const index = store.index('timestamp');

            const request = index.getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    }

    async clearAction(id) {
        if (!this.db) await this.init();

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('offline_queue', 'readwrite');
            const store = tx.objectStore('offline_queue');

            const request = store.delete(id);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async clearAllActions() {
        if (!this.db) await this.init();

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('offline_queue', 'readwrite');
            const store = tx.objectStore('offline_queue');

            const request = store.clear();
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async getQueueLength() {
        if (!this.db) await this.init();

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('offline_queue', 'readonly');
            const store = tx.objectStore('offline_queue');

            const request = store.count();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    // ===== SECTIONS CACHE METHODS =====

    async saveSections(sections) {
        if (!this.db) await this.init();

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('sections', 'readwrite');
            const store = tx.objectStore('sections');

            // Clear existing data
            store.clear();

            // Add new data
            for (const section of sections) {
                store.add(section);
            }

            tx.oncomplete = () => {
                console.log('[OfflineStorage] Sections cached:', sections.length);
                resolve();
            };
            tx.onerror = () => reject(tx.error);
        });
    }

    async getSections() {
        if (!this.db) await this.init();

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('sections', 'readonly');
            const store = tx.objectStore('sections');
            const index = store.index('sort_order');

            const request = index.getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    }

    // ===== SYNC METADATA METHODS =====

    async setMetadata(key, value) {
        if (!this.db) await this.init();

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('sync_metadata', 'readwrite');
            const store = tx.objectStore('sync_metadata');

            const request = store.put({ key, value });
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async getMetadata(key) {
        if (!this.db) await this.init();

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('sync_metadata', 'readonly');
            const store = tx.objectStore('sync_metadata');

            const request = store.get(key);
            request.onsuccess = () => resolve(request.result?.value);
            request.onerror = () => reject(request.error);
        });
    }

    async getLastSyncTimestamp() {
        return this.getMetadata('last_sync');
    }

    async setLastSyncTimestamp(timestamp) {
        return this.setMetadata('last_sync', timestamp);
    }

    // ===== OPTIMISTIC UPDATES =====

    async updateItemInCache(itemId, updates) {
        if (!this.db) await this.init();

        const sections = await this.getSections();
        let modified = false;

        for (const section of sections) {
            if (section.items) {
                for (let i = 0; i < section.items.length; i++) {
                    if (section.items[i].id === itemId) {
                        section.items[i] = { ...section.items[i], ...updates };
                        modified = true;
                        break;
                    }
                }
            }
            if (modified) break;
        }

        if (modified) {
            await this.saveSections(sections);
        }
        return modified;
    }

    async removeItemFromCache(itemId) {
        if (!this.db) await this.init();

        const sections = await this.getSections();
        let modified = false;

        for (const section of sections) {
            if (section.items) {
                const index = section.items.findIndex(item => item.id === itemId);
                if (index !== -1) {
                    section.items.splice(index, 1);
                    modified = true;
                    break;
                }
            }
        }

        if (modified) {
            await this.saveSections(sections);
        }
        return modified;
    }
}

// Create global instance
window.offlineStorage = new OfflineStorage();
