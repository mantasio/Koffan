// Shopping List Alpine.js Component
function shoppingList() {
    return {
        // WebSocket
        ws: null,
        connected: false,
        reconnectAttempts: 0,
        maxReconnectAttempts: 5,

        // Offline support
        isOnline: navigator.onLine,
        processingQueue: false,
        offlineStorageReady: false,

        // Modals
        showManageSections: false,
        showAddItem: false,
        showEditModal: false,
        showSettings: false,
        showOfflineModal: false,

        // Section management
        selectMode: false,
        selectedSections: [],

        // Stats (updated from server)
        stats: {
            total: window.initialStats?.total || 0,
            completed: window.initialStats?.completed || 0,
            percentage: window.initialStats?.percentage || 0
        },

        // Current item for mobile actions
        mobileActionItem: null,

        // Edit item
        editingItem: null,
        editItemName: '',
        editItemDescription: '',

        // Track pending local actions to avoid WebSocket race conditions
        pendingLocalActions: {},
        localActionTimeout: 1000, // ms to ignore WebSocket updates after local action

        async init() {
            await this.initOffline();
            this.initWebSocket();
            this.initCompletedSectionsStore();
            this.initLocalActionTracking();

            // Listen for mobile action modal
            this.$el.addEventListener('open-mobile-action', (e) => {
                this.openMobileAction(e.detail);
            });

            // Listen for move item events (use window because $dispatch bubbles to window)
            window.addEventListener('move-item', (e) => {
                this.moveItemAnimated(e.detail.id, e.detail.direction);
            });

            // Listen for uncertain toggle events (use window because $dispatch bubbles to window)
            window.addEventListener('toggle-uncertain', (e) => {
                this.toggleUncertainAnimated(e.detail.id);
            });

            // Keyboard shortcut for save (Cmd+Enter)
            document.addEventListener('keydown', (e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && this.editingItem) {
                    e.preventDefault();
                    this.submitEditItem();
                }
            });
        },

        initCompletedSectionsStore() {
            // Załaduj stan z localStorage
            try {
                const saved = localStorage.getItem('completedSections');
                Alpine.store('completedSections', saved ? JSON.parse(saved) : {});
            } catch (e) {
                Alpine.store('completedSections', {});
            }
        },

        saveCompletedSections() {
            try {
                const store = Alpine.store('completedSections');
                localStorage.setItem('completedSections', JSON.stringify(store));
            } catch (e) {
                console.error('Failed to save completed sections:', e);
            }
        },

        initLocalActionTracking() {
            // Listen for HTMX requests to track local actions
            document.body.addEventListener('htmx:beforeRequest', (e) => {
                const path = e.detail.requestConfig?.path || '';
                // Track reorder actions
                if (path.includes('/move-up') || path.includes('/move-down')) {
                    this.markLocalAction('items_reordered');
                }
                // Track delete actions
                if (e.detail.requestConfig?.verb === 'delete' && path.includes('/items/')) {
                    this.markLocalAction('item_deleted');
                }
                // Track uncertain toggle
                if (path.includes('/uncertain')) {
                    this.markLocalAction('item_updated');
                }
                // Track item toggle (checked/unchecked)
                if (path.includes('/toggle')) {
                    this.markLocalAction('item_toggled');
                }
            });
        },

        markLocalAction(actionType) {
            this.pendingLocalActions[actionType] = Date.now();
            // Auto-clear after timeout
            setTimeout(() => {
                if (this.pendingLocalActions[actionType] &&
                    Date.now() - this.pendingLocalActions[actionType] >= this.localActionTimeout) {
                    delete this.pendingLocalActions[actionType];
                }
            }, this.localActionTimeout + 100);
        },

        isLocalAction(actionType) {
            const timestamp = this.pendingLocalActions[actionType];
            if (timestamp && Date.now() - timestamp < this.localActionTimeout) {
                return true;
            }
            return false;
        },

        // ===== OFFLINE SUPPORT =====

        async initOffline() {
            // Initialize IndexedDB
            try {
                await window.offlineStorage.init();
                this.offlineStorageReady = true;
                console.log('[App] Offline storage initialized');

                // Cache data on load if online
                if (this.isOnline) {
                    this.cacheData();
                }
            } catch (error) {
                console.error('[App] Failed to initialize offline storage:', error);
            }

            // Online/offline event listeners
            window.addEventListener('online', () => {
                console.log('[App] Back online');
                this.isOnline = true;
                this.processOfflineQueue();
            });

            window.addEventListener('offline', () => {
                console.log('[App] Gone offline');
                this.isOnline = false;
            });
        },

        async cacheData() {
            if (!this.offlineStorageReady) return;

            try {
                const response = await fetch('/api/data');
                if (response.ok) {
                    const data = await response.json();
                    await window.offlineStorage.saveSections(data.sections || []);
                    await window.offlineStorage.setLastSyncTimestamp(data.timestamp);
                    console.log('[App] Data cached for offline use');
                }
            } catch (error) {
                console.error('[App] Failed to cache data:', error);
            }
        },

        async queueOfflineAction(action) {
            if (!this.offlineStorageReady) {
                console.warn('[App] Offline storage not ready, action lost:', action);
                return;
            }

            await window.offlineStorage.queueAction(action);
            console.log('[App] Action queued for sync:', action.type);
        },

        async processOfflineQueue() {
            if (this.processingQueue || !this.isOnline || !this.offlineStorageReady) return;

            this.processingQueue = true;
            console.log('[App] Processing offline queue...');

            try {
                const actions = await window.offlineStorage.getQueuedActions();

                if (actions.length === 0) {
                    console.log('[App] No queued actions');
                    this.processingQueue = false;
                    return;
                }

                console.log('[App] Processing', actions.length, 'queued actions');

                for (const action of actions) {
                    try {
                        const fetchOptions = {
                            method: action.method,
                            headers: action.headers || {}
                        };

                        if (action.body) {
                            fetchOptions.body = action.body;
                        }

                        const response = await fetch(action.url, fetchOptions);

                        if (response.ok || response.status === 404) {
                            // Success or item no longer exists - remove from queue
                            await window.offlineStorage.clearAction(action.id);
                            console.log('[App] Synced action:', action.type);
                        } else {
                            console.error('[App] Failed to sync action:', action.type, response.status);
                        }
                    } catch (error) {
                        console.error('[App] Error syncing action:', action.type, error);
                        // Keep in queue for retry
                    }
                }

                // Refresh data after sync
                await this.cacheData();
                this.refreshList();
                this.refreshStats();

            } finally {
                this.processingQueue = false;
            }
        },

        async fullRefresh() {
            console.log('[App] Full refresh triggered');

            // Process any pending offline actions first
            if (this.isOnline) {
                await this.processOfflineQueue();
            }

            // Reconnect WebSocket if needed
            if (!this.connected && this.isOnline) {
                this.reconnectAttempts = 0;
                this.connect();
            }

            // Refresh from server
            if (this.isOnline) {
                this.refreshList();
                this.refreshStats();
                this.cacheData();
            }
        },

        // Wrapper for fetch that queues action when offline
        async offlineFetch(url, options, actionType) {
            if (this.isOnline) {
                return fetch(url, options);
            }

            // Queue action for later sync
            await this.queueOfflineAction({
                type: actionType,
                url: url,
                method: options.method || 'GET',
                headers: options.headers || {},
                body: options.body || null
            });

            // Return fake successful response
            return { ok: true, offline: true };
        },

        // ===== WEBSOCKET =====

        initWebSocket() {
            this.connect();

            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible') {
                    // Full refresh when returning from background
                    this.fullRefresh();
                }
            });
        },

        connect() {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsUrl = `${protocol}//${window.location.host}/ws`;

            try {
                this.ws = new WebSocket(wsUrl);

                this.ws.onopen = () => {
                    console.log('WebSocket connected');
                    this.connected = true;
                    this.reconnectAttempts = 0;
                };

                this.ws.onclose = () => {
                    console.log('WebSocket disconnected');
                    this.connected = false;
                    this.scheduleReconnect();
                };

                this.ws.onerror = (error) => {
                    console.error('WebSocket error:', error);
                };

                this.ws.onmessage = (event) => {
                    this.handleMessage(event.data);
                };

                this.startPingPong();
            } catch (error) {
                console.error('Failed to create WebSocket:', error);
                this.scheduleReconnect();
            }
        },

        scheduleReconnect() {
            if (this.reconnectAttempts >= this.maxReconnectAttempts) {
                console.log('Max reconnection attempts reached');
                return;
            }

            this.reconnectAttempts++;
            const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
            setTimeout(() => this.connect(), delay);
        },

        startPingPong() {
            setInterval(() => {
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    this.ws.send(JSON.stringify({ type: 'ping' }));
                }
            }, 30000);
        },

        handleMessage(data) {
            try {
                const message = JSON.parse(data);
                console.log('WebSocket message:', message.type);

                switch (message.type) {
                    case 'section_created':
                    case 'section_updated':
                    case 'section_deleted':
                    case 'sections_deleted':
                    case 'sections_reordered':
                        // Sekcje się zmieniły - odśwież listę sekcji i selecty
                        this.refreshSectionsAndSelects();
                        break;
                    case 'item_created':
                    case 'item_moved':
                        // Wymaga pełnego odświeżenia listy
                        this.refreshList();
                        this.refreshStats();
                        break;
                    case 'item_deleted':
                        // Jeśli to lokalna akcja - HTMX już usunął element
                        // Jeśli zdalna - odśwież listę żeby zsynchronizować
                        if (!this.isLocalAction('item_deleted')) {
                            this.refreshList();
                        }
                        this.refreshStats();
                        break;
                    case 'items_reordered':
                        // Jeśli to lokalna akcja - HTMX już zaktualizował kolejność
                        // Jeśli zdalna - odśwież listę żeby zsynchronizować
                        if (!this.isLocalAction('items_reordered')) {
                            this.refreshList();
                        }
                        this.refreshStats();
                        break;
                    case 'item_toggled':
                        // Jeśli to lokalna akcja - HTMX już zaktualizował element
                        // Jeśli zdalna - odśwież listę żeby zsynchronizować
                        if (!this.isLocalAction('item_toggled')) {
                            this.refreshList();
                        }
                        this.refreshStats();
                        break;
                    case 'item_updated':
                        // Jeśli to lokalna akcja - HTMX już zaktualizował element
                        // Jeśli zdalna - odśwież listę żeby zsynchronizować
                        if (!this.isLocalAction('item_updated')) {
                            this.refreshList();
                        }
                        this.refreshStats();
                        break;
                    case 'pong':
                        break;
                    default:
                        console.log('Unknown message type:', message.type);
                }
            } catch (error) {
                console.error('Failed to parse WebSocket message:', error);
            }
        },

        refreshList() {
            const sectionsList = document.getElementById('sections-list');
            if (sectionsList) {
                htmx.ajax('GET', '/', {
                    target: '#sections-list',
                    swap: 'innerHTML',
                    select: '#sections-list > *'
                });
            }

            const manageSectionsList = document.getElementById('manage-sections-list');
            if (manageSectionsList) {
                htmx.ajax('GET', '/sections/list', {
                    target: '#manage-sections-list',
                    swap: 'innerHTML'
                });
            }
        },

        refreshSection(sectionId) {
            const section = document.getElementById(`section-${sectionId}`);
            if (section) {
                htmx.ajax('GET', '/', {
                    target: `#section-${sectionId}`,
                    swap: 'outerHTML',
                    select: `#section-${sectionId}`
                });
            }
        },

        refreshItem(itemId) {
            const item = document.getElementById(`item-${itemId}`);
            if (item) {
                htmx.ajax('GET', '/', {
                    target: `#item-${itemId}`,
                    swap: 'outerHTML',
                    select: `#item-${itemId}`
                });
            }
        },

        async refreshSectionsAndSelects() {
            // Odśwież listę sekcji w modalu zarządzania
            const manageSectionsList = document.getElementById('manage-sections-list');
            if (manageSectionsList) {
                htmx.ajax('GET', '/sections/list', {
                    target: '#manage-sections-list',
                    swap: 'innerHTML'
                });
            }

            // Odśwież główną listę sekcji
            this.refreshList();

            // Pobierz nowe sekcje i zaktualizuj selecty
            try {
                const response = await fetch('/sections/list?format=json');
                if (response.ok) {
                    const sections = await response.json();
                    this.updateSectionSelects(sections);
                }
            } catch (error) {
                console.error('Failed to refresh sections:', error);
            }
        },

        updateSectionSelects(sections) {
            // Znajdź wszystkie selecty z sekcjami
            const selects = document.querySelectorAll('select[name="section_id"]');
            selects.forEach(select => {
                const currentValue = select.value;
                // Zachowaj pierwszą opcję (placeholder)
                const placeholder = select.querySelector('option[value=""]');

                // Wyczyść wszystkie opcje
                select.innerHTML = '';

                // Dodaj placeholder
                if (placeholder) {
                    select.appendChild(placeholder);
                } else {
                    const opt = document.createElement('option');
                    opt.value = '';
                    opt.textContent = t('items.section');
                    select.appendChild(opt);
                }

                // Dodaj nowe opcje
                sections.forEach(section => {
                    const opt = document.createElement('option');
                    opt.value = section.id;
                    opt.textContent = section.name;
                    select.appendChild(opt);
                });

                // Przywróć poprzednią wartość jeśli nadal istnieje
                if (currentValue && sections.some(s => s.id == currentValue)) {
                    select.value = currentValue;
                }
            });
        },

        async refreshStats() {
            try {
                const response = await fetch('/stats');
                if (response.ok) {
                    const data = await response.json();
                    // JSON używa snake_case
                    this.stats = {
                        total: data.total_items || 0,
                        completed: data.completed_items || 0,
                        percentage: data.percentage || 0
                    };
                }
            } catch (error) {
                console.error('Failed to refresh stats:', error);
            }
        },

        // Section Management
        toggleSection(id) {
            const index = this.selectedSections.indexOf(id);
            if (index > -1) {
                this.selectedSections.splice(index, 1);
            } else {
                this.selectedSections.push(id);
            }
        },

        async deleteSelectedSections() {
            if (this.selectedSections.length === 0) return;

            const confirmed = confirm(t('confirm.delete_sections', { count: this.selectedSections.length }));
            if (!confirmed) return;

            try {
                const response = await fetch('/sections/batch-delete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: `ids=${this.selectedSections.join(',')}`
                });

                if (response.ok) {
                    this.selectMode = false;
                    this.selectedSections = [];
                    // Odśwież listę sekcji i selecty bez przeładowania strony
                    this.refreshSectionsAndSelects();
                }
            } catch (error) {
                console.error('Failed to delete sections:', error);
            }
        },

        // Mobile Action Modal
        openMobileAction(item) {
            this.mobileActionItem = {
                id: item.id,
                name: item.name,
                description: item.description || '',
                section_id: item.section_id,
                uncertain: item.uncertain
            };
        },

        closeMobileAction() {
            this.mobileActionItem = null;
        },

        async toggleUncertain() {
            if (!this.mobileActionItem) return;
            const itemId = this.mobileActionItem.id;

            // Mark as local action to prevent WebSocket race condition
            this.markLocalAction('item_updated');

            // Optimistic UI update
            this.mobileActionItem.uncertain = !this.mobileActionItem.uncertain;
            this.mobileActionItem = null;

            try {
                const response = await this.offlineFetch(
                    `/items/${itemId}/uncertain`,
                    { method: 'POST' },
                    'toggle_uncertain'
                );

                if (response.ok && !response.offline) {
                    this.refreshList();
                }
            } catch (error) {
                console.error('Failed to toggle uncertain:', error);
                // Queue for offline sync
                await this.queueOfflineAction({
                    type: 'toggle_uncertain',
                    url: `/items/${itemId}/uncertain`,
                    method: 'POST'
                });
            }

            this.refreshList();
        },

        async moveToSection(sectionId) {
            if (!this.mobileActionItem) return;
            const itemId = this.mobileActionItem.id;
            this.mobileActionItem = null;

            try {
                const response = await this.offlineFetch(
                    `/items/${itemId}/move`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        body: `section_id=${sectionId}`
                    },
                    'move_item'
                );

                if (response.ok) {
                    this.refreshList();
                }
            } catch (error) {
                console.error('Failed to move item:', error);
                await this.queueOfflineAction({
                    type: 'move_item',
                    url: `/items/${itemId}/move`,
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: `section_id=${sectionId}`
                });
                this.refreshList();
            }
        },

        async deleteItem() {
            if (!this.mobileActionItem) return;
            const confirmed = confirm(t('confirm.delete_item', { name: this.mobileActionItem.name }));
            if (!confirmed) return;

            const itemId = this.mobileActionItem.id;

            // Optimistic UI - remove item from DOM
            const itemEl = document.getElementById(`item-${itemId}`);
            if (itemEl) {
                itemEl.classList.add('item-exit');
                setTimeout(() => itemEl.remove(), 200);
            }

            this.mobileActionItem = null;
            this.markLocalAction('item_deleted');

            try {
                const response = await this.offlineFetch(
                    `/items/${itemId}`,
                    { method: 'DELETE' },
                    'delete_item'
                );

                if (response.ok) {
                    this.refreshStats();
                }
            } catch (error) {
                console.error('Failed to delete item:', error);
                await this.queueOfflineAction({
                    type: 'delete_item',
                    url: `/items/${itemId}`,
                    method: 'DELETE'
                });
            }

            this.refreshStats();
        },

        // Edit Item
        editItem(item) {
            this.editingItem = item;
            this.editItemName = item.name;
            this.editItemDescription = item.description || '';
            this.$nextTick(() => {
                const input = document.querySelector('[x-model="editItemName"]');
                if (input) input.focus();
            });
        },

        async submitEditItem() {
            if (!this.editItemName.trim() || !this.editingItem) return;

            const itemId = this.editingItem.id;
            const name = this.editItemName.trim();
            const description = this.editItemDescription.trim();
            const body = `name=${encodeURIComponent(name)}&description=${encodeURIComponent(description)}`;

            this.editingItem = null;
            this.editItemName = '';
            this.editItemDescription = '';

            try {
                const response = await this.offlineFetch(
                    `/items/${itemId}`,
                    {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        body: body
                    },
                    'edit_item'
                );

                if (response.ok) {
                    this.refreshList();
                }
            } catch (error) {
                console.error('Failed to save edit:', error);
                await this.queueOfflineAction({
                    type: 'edit_item',
                    url: `/items/${itemId}`,
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: body
                });
                this.refreshList();
            }
        },

        // Animated item move (swap two items in DOM)
        async moveItemAnimated(itemId, direction) {
            const item = document.getElementById(`item-${itemId}`);
            if (!item) return;

            // Find sibling to swap with
            let sibling;
            if (direction === 'up') {
                sibling = item.previousElementSibling;
                // Skip non-item elements
                while (sibling && !sibling.id?.startsWith('item-')) {
                    sibling = sibling.previousElementSibling;
                }
            } else {
                sibling = item.nextElementSibling;
                while (sibling && !sibling.id?.startsWith('item-')) {
                    sibling = sibling.nextElementSibling;
                }
            }

            if (!sibling) return; // Already at top/bottom

            // Calculate distance before any changes
            const itemRect = item.getBoundingClientRect();
            const siblingRect = sibling.getBoundingClientRect();
            const distance = siblingRect.top - itemRect.top;

            // Disable all transitions on elements
            item.style.cssText = 'transition: none !important;';
            sibling.style.cssText = 'transition: none !important;';

            // Force reflow
            item.offsetHeight;

            // Now add transform transition and animate
            item.style.cssText = 'transition: transform 0.2s ease-out !important;';
            sibling.style.cssText = 'transition: transform 0.2s ease-out !important;';

            // Animate
            item.style.transform = `translateY(${distance}px)`;
            sibling.style.transform = `translateY(${-distance}px)`;

            // After animation, actually swap in DOM
            setTimeout(() => {
                // Disable transitions before DOM swap
                item.style.cssText = 'transition: none !important;';
                sibling.style.cssText = 'transition: none !important;';
                item.style.transform = '';
                sibling.style.transform = '';

                // Swap in DOM
                if (direction === 'up') {
                    sibling.parentNode.insertBefore(item, sibling);
                } else {
                    sibling.parentNode.insertBefore(sibling, item);
                }

                // Force reflow after DOM swap
                item.offsetHeight;

                // Clear all inline styles
                item.style.cssText = '';
                sibling.style.cssText = '';
            }, 200);

            // Send request to server in background
            this.markLocalAction('items_reordered');
            try {
                const response = await this.offlineFetch(
                    `/items/${itemId}/move-${direction}`,
                    { method: 'POST' },
                    'move_item_order'
                );

                if (!response.ok && !response.offline) {
                    console.error('Failed to move item on server');
                }
            } catch (error) {
                console.error('Failed to move item:', error);
                await this.queueOfflineAction({
                    type: 'move_item_order',
                    url: `/items/${itemId}/move-${direction}`,
                    method: 'POST'
                });
            }
        },

        // Toggle uncertain status with animation (no page refresh)
        async toggleUncertainAnimated(itemId) {
            const item = document.getElementById(`item-${itemId}`);
            if (!item) return;

            // Check current state from DOM (has amber background = uncertain)
            const currentlyUncertain = item.classList.contains('bg-amber-50/50');
            const newState = !currentlyUncertain;

            // Update item background
            if (newState) {
                item.classList.add('bg-amber-50/50');
            } else {
                item.classList.remove('bg-amber-50/50');
            }

            // Update ? icon in content
            const contentDiv = item.querySelector('.flex-1.min-w-0');
            if (contentDiv) {
                const innerDiv = contentDiv.querySelector('.flex.items-center.gap-2');
                if (innerDiv) {
                    const questionMark = innerDiv.querySelector('.text-amber-500.text-xs');
                    if (newState && !questionMark) {
                        const span = document.createElement('span');
                        span.className = 'text-amber-500 text-xs';
                        span.textContent = '?';
                        innerDiv.insertBefore(span, innerDiv.firstChild);
                    } else if (!newState && questionMark) {
                        questionMark.remove();
                    }
                }
            }

            // Update button color and icon fill
            const btn = item.querySelector('.uncertain-btn');
            if (btn) {
                if (newState) {
                    btn.classList.remove('text-stone-400');
                    btn.classList.add('text-amber-500');
                } else {
                    btn.classList.remove('text-amber-500');
                    btn.classList.add('text-stone-400');
                }

                const svg = btn.querySelector('.uncertain-icon');
                if (svg) {
                    svg.setAttribute('fill', newState ? 'currentColor' : 'none');
                }
            }

            // Send request to server in background
            this.markLocalAction('item_updated');
            try {
                const response = await this.offlineFetch(
                    `/items/${itemId}/uncertain`,
                    { method: 'POST' },
                    'toggle_uncertain'
                );

                if (response.ok) {
                    this.refreshStats();
                }
            } catch (error) {
                console.error('Failed to toggle uncertain:', error);
                await this.queueOfflineAction({
                    type: 'toggle_uncertain',
                    url: `/items/${itemId}/uncertain`,
                    method: 'POST'
                });
            }
        }
    };
}

// HTMX configuration
document.addEventListener('DOMContentLoaded', function() {
    htmx.config.defaultSwapStyle = 'outerHTML';
    htmx.config.globalViewTransitions = true;

    // Track existing items before swap to animate only new ones
    let existingItemIds = new Set();

    // Counter for temporary offline IDs
    let offlineItemCounter = Date.now();

    // Intercept HTMX requests when offline
    document.body.addEventListener('htmx:beforeRequest', function(event) {
        if (navigator.onLine) return; // Online - let HTMX handle it

        const path = event.detail.requestConfig?.path || '';
        const verb = event.detail.requestConfig?.verb?.toUpperCase() || 'GET';

        // Handle POST /items (add item) offline
        if (verb === 'POST' && path === '/items') {
            event.preventDefault();

            const form = event.detail.elt;
            const formData = new FormData(form);
            const sectionId = formData.get('section_id');
            const name = formData.get('name');
            const description = formData.get('description') || '';

            if (!sectionId || !name) return;

            // Generate temporary ID
            const tempId = 'offline-' + (++offlineItemCounter);

            // Create optimistic item HTML
            const itemHtml = createOfflineItemHtml(tempId, name, description, sectionId);

            // Find the section by exact ID and add item to it
            const sectionEl = document.getElementById(`section-${sectionId}`);
            if (sectionEl) {
                // Show section if it was hidden (empty section)
                sectionEl.classList.remove('hidden');

                // Find the active items container (not completed items)
                const itemsContainer = sectionEl.querySelector('.active-items');
                if (itemsContainer) {
                    // Insert at the beginning (newest first based on sort_order)
                    itemsContainer.insertAdjacentHTML('afterbegin', itemHtml);

                    // Add animation
                    const newItem = document.getElementById(`item-${tempId}`);
                    if (newItem) {
                        newItem.classList.add('item-enter');
                        setTimeout(() => newItem.classList.remove('item-enter'), 300);
                    }

                    // Update section counter
                    const counter = sectionEl.querySelector('.section-counter');
                    if (counter) {
                        const text = counter.textContent;
                        const match = text.match(/(\d+)\/(\d+)/);
                        if (match) {
                            const completed = parseInt(match[1]);
                            const total = parseInt(match[2]) + 1;
                            counter.textContent = `${completed}/${total}`;
                        } else {
                            counter.textContent = '0/1';
                        }
                    }
                }
            } else {
                console.warn('[Offline] Section not found in DOM:', sectionId);
            }

            // Queue action for sync
            window.offlineStorage.queueAction({
                type: 'create_item',
                url: '/items',
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: `section_id=${sectionId}&name=${encodeURIComponent(name)}&description=${encodeURIComponent(description)}`,
                tempId: tempId
            }).then(() => {
                console.log('[Offline] Item queued:', name);
            });

            // Clear form (use appropriate method based on form type)
            if (typeof clearFormKeepSection === 'function' && form.id === 'add-item-form') {
                clearFormKeepSection(form);
            } else {
                form.reset();
            }

            // Update stats and close mobile modal
            const alpineData = Alpine.$data(document.querySelector('[x-data="shoppingList()"]'));
            if (alpineData) {
                alpineData.stats.total++;
                // Close mobile add item modal if open
                alpineData.showAddItem = false;
            }

            return false;
        }

        // Handle POST /items/:id/toggle offline
        if (verb === 'POST' && path.match(/\/items\/\d+\/toggle/)) {
            event.preventDefault();

            const itemId = path.match(/\/items\/(\d+)\/toggle/)[1];

            // Queue for sync
            window.offlineStorage.queueAction({
                type: 'toggle_item',
                url: path,
                method: 'POST'
            });

            // Optimistic UI is already handled by existing code
            console.log('[Offline] Toggle queued:', itemId);
            return false;
        }

        // Handle DELETE /items/:id offline
        if (verb === 'DELETE' && path.match(/\/items\/\d+$/)) {
            event.preventDefault();

            const itemId = path.match(/\/items\/(\d+)$/)[1];
            const itemEl = document.getElementById(`item-${itemId}`);

            if (itemEl) {
                itemEl.classList.add('item-exit');
                setTimeout(() => itemEl.remove(), 200);
            }

            // Queue for sync
            window.offlineStorage.queueAction({
                type: 'delete_item',
                url: path,
                method: 'DELETE'
            });

            // Update stats optimistically
            const alpineData = Alpine.$data(document.querySelector('[x-data="shoppingList()"]'));
            if (alpineData) {
                alpineData.stats.total = Math.max(0, alpineData.stats.total - 1);
            }

            console.log('[Offline] Delete queued:', itemId);
            return false;
        }
    });

    document.body.addEventListener('htmx:responseError', function(event) {
        console.error('HTMX error:', event.detail);
        if (event.detail.xhr.status === 401) {
            window.location.href = '/login';
        }
    });

    document.body.addEventListener('htmx:beforeSwap', function(event) {
        const redirectUrl = event.detail.xhr.getResponseHeader('HX-Redirect');
        if (redirectUrl) {
            window.location.href = redirectUrl;
            event.detail.shouldSwap = false;
        }

        // Capture existing item IDs before swap
        if (event.detail.target?.id === 'sections-list') {
            existingItemIds = new Set(
                [...document.querySelectorAll('[id^="item-"]')].map(el => el.id)
            );
        }
    });

    document.body.addEventListener('htmx:afterSwap', function(event) {
        // Animate only new items after swap
        if (event.detail.target?.id === 'sections-list') {
            document.querySelectorAll('[id^="item-"]').forEach(el => {
                if (!existingItemIds.has(el.id)) {
                    el.classList.add('item-enter');
                    // Remove animation class after it completes
                    setTimeout(() => el.classList.remove('item-enter'), 300);
                }
            });
            existingItemIds.clear();
        }
    });

});

// Create HTML for offline item (simplified version without all actions)
function createOfflineItemHtml(id, name, description, sectionId) {
    const descHtml = description
        ? `<p class="text-xs text-stone-400 truncate mt-0.5">${escapeHtml(description)}</p>`
        : '';

    return `
<div id="item-${id}" class="px-4 py-3 flex items-center gap-3 hover:bg-stone-50 transition-all group bg-amber-50/30 border-l-2 border-amber-400">
    <!-- Checkbox (disabled offline) -->
    <div class="flex-shrink-0 w-5 h-5 rounded-full border-2 border-stone-200 bg-stone-50"></div>

    <!-- Content -->
    <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2">
            <span class="text-amber-500 text-xs" title="Oczekuje na synchronizację">⏳</span>
            <p class="text-sm text-stone-700 truncate">${escapeHtml(name)}</p>
        </div>
        ${descHtml}
    </div>

    <!-- Offline indicator -->
    <span class="text-xs text-amber-500 font-medium">offline</span>
</div>`;
}

// Escape HTML to prevent XSS
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Global function for uncertain toggle (called from onclick)
window.toggleUncertain = async function(itemId) {
    const item = document.getElementById(`item-${itemId}`);
    if (!item) return;

    // Check current state from DOM
    const currentlyUncertain = item.classList.contains('bg-amber-50/50');
    const newState = !currentlyUncertain;

    // Animate the button
    const btn = item.querySelector('.uncertain-btn');
    if (btn) {
        btn.classList.add('checkbox-pulse');
        setTimeout(() => btn.classList.remove('checkbox-pulse'), 300);
    }

    // Update item background with smooth transition
    if (newState) {
        item.classList.add('bg-amber-50/50');
    } else {
        item.classList.remove('bg-amber-50/50');
    }

    // Update ? icon in content
    const contentDiv = item.querySelector('.flex-1.min-w-0');
    if (contentDiv) {
        const innerDiv = contentDiv.querySelector('.flex.items-center.gap-2');
        if (innerDiv) {
            const questionMark = innerDiv.querySelector('.text-amber-500.text-xs');
            if (newState && !questionMark) {
                const span = document.createElement('span');
                span.className = 'text-amber-500 text-xs';
                span.textContent = '?';
                innerDiv.insertBefore(span, innerDiv.firstChild);
            } else if (!newState && questionMark) {
                questionMark.remove();
            }
        }
    }

    // Update button color and icon fill
    if (btn) {
        if (newState) {
            btn.classList.remove('text-stone-400');
            btn.classList.add('text-amber-500');
        } else {
            btn.classList.remove('text-amber-500');
            btn.classList.add('text-stone-400');
        }

        const svg = btn.querySelector('.uncertain-icon');
        if (svg) {
            svg.setAttribute('fill', newState ? 'currentColor' : 'none');
        }
    }

    // Send request to server in background
    try {
        if (navigator.onLine) {
            await fetch(`/items/${itemId}/uncertain`, { method: 'POST' });
        } else {
            // Queue for offline sync
            await window.offlineStorage.queueAction({
                type: 'toggle_uncertain',
                url: `/items/${itemId}/uncertain`,
                method: 'POST'
            });
        }
    } catch (error) {
        console.error('Failed to toggle uncertain:', error);
        // Queue for offline sync on error
        try {
            await window.offlineStorage.queueAction({
                type: 'toggle_uncertain',
                url: `/items/${itemId}/uncertain`,
                method: 'POST'
            });
        } catch (e) {
            console.error('Failed to queue action:', e);
        }
    }
};
