const express = require('express');
const WebSocket = require('ws');
const https = require('https');
const http = require('http');
const fs = require('fs');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

// Configuration
const HTTP_PORT = 3000;
const WS_PORT = 3001;
const WSS_PORT = 3002;

// Express app setup
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Store connected clients
const clients = new Map();
const rooms = new Map();

// Client class để quản lý thông tin client
class Client {
    constructor(ws, id, type = 'unknown') {
        this.id = id;
        this.ws = ws;
        this.type = type; // 'printer', 'web', 'mobile', etc.
        this.room = null;
        this.metadata = {};
        this.lastPing = Date.now();
    }

    send(data) {
        if (this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(data));
            return true;
        }
        return false;
    }

    joinRoom(roomId) {
        if (this.room) {
            this.leaveRoom();
        }
        this.room = roomId;
        if (!rooms.has(roomId)) {
            rooms.set(roomId, new Set());
        }
        rooms.get(roomId).add(this.id);
    }

    leaveRoom() {
        if (this.room && rooms.has(this.room)) {
            rooms.get(this.room).delete(this.id);
            if (rooms.get(this.room).size === 0) {
                rooms.delete(this.room);
            }
            this.room = null;
        }
    }
}

// Utility functions
function broadcastToRoom(roomId, data, excludeClientId = null) {
    if (!rooms.has(roomId)) return 0;
    
    let sentCount = 0;
    rooms.get(roomId).forEach(clientId => {
        if (clientId !== excludeClientId && clients.has(clientId)) {
            const client = clients.get(clientId);
            if (client.send(data)) {
                sentCount++;
            }
        }
    });
    return sentCount;
}

function broadcastToAll(data, excludeClientId = null) {
    let sentCount = 0;
    clients.forEach((client, clientId) => {
        if (clientId !== excludeClientId) {
            if (client.send(data)) {
                sentCount++;
            }
        }
    });
    return sentCount;
}

function getClientsByType(type) {
    const result = [];
    clients.forEach((client, clientId) => {
        if (client.type === type) {
            result.push({
                id: clientId,
                type: client.type,
                room: client.room,
                metadata: client.metadata,
                lastPing: client.lastPing
            });
        }
    });
    return result;
}

// WebSocket Server Setup
function createWebSocketServer(server, isSecure = false) {
    const wss = new WebSocket.Server({ server });
    
    wss.on('connection', (ws, req) => {
        const clientId = uuidv4();
        const client = new Client(ws, clientId);
        clients.set(clientId, client);
        
        console.log(`🔗 Client connected: ${clientId} (${isSecure ? 'WSS' : 'WS'})`);
        
        // Send welcome message
        client.send({
            type: 'welcome',
            clientId: clientId,
            message: 'Connected to Bridge Server',
            serverInfo: {
                secure: isSecure,
                timestamp: new Date().toISOString()
            }
        });
        
        ws.on('message', (message) => {
            try {
                const data = JSON.parse(message);
                handleMessage(client, data);
            } catch (error) {
                console.error('❌ Invalid JSON message:', error);
                client.send({
                    type: 'error',
                    message: 'Invalid JSON format'
                });
            }
        });
        
        ws.on('close', () => {
            console.log(`🔌 Client disconnected: ${clientId}`);
            client.leaveRoom();
            clients.delete(clientId);
            
            // Notify other clients
            broadcastToAll({
                type: 'client_disconnected',
                clientId: clientId
            }, clientId);
        });
        
        ws.on('error', (error) => {
            console.error(`❌ WebSocket error for ${clientId}:`, error);
        });
        
        // Ping/Pong for connection health
        const pingInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.ping();
            } else {
                clearInterval(pingInterval);
            }
        }, 30000);
        
        ws.on('pong', () => {
            client.lastPing = Date.now();
        });
    });
    
    return wss;
}

// Message handling
function handleMessage(client, data) {
    console.log(`📨 Message from ${client.id}:`, data);
    
    switch (data.type) {
        case 'register':
            client.type = data.clientType || 'unknown';
            client.metadata = data.metadata || {};
            client.send({
                type: 'registered',
                clientId: client.id,
                clientType: client.type
            });
            
            // Notify other clients
            broadcastToAll({
                type: 'client_registered',
                clientId: client.id,
                clientType: client.type,
                metadata: client.metadata
            }, client.id);
            break;
            
        case 'join_room':
            client.joinRoom(data.roomId);
            client.send({
                type: 'room_joined',
                roomId: data.roomId
            });
            
            // Notify room members
            broadcastToRoom(data.roomId, {
                type: 'client_joined_room',
                clientId: client.id,
                clientType: client.type,
                roomId: data.roomId
            }, client.id);
            break;
            
        case 'leave_room':
            const oldRoom = client.room;
            client.leaveRoom();
            client.send({
                type: 'room_left',
                roomId: oldRoom
            });
            
            if (oldRoom) {
                broadcastToRoom(oldRoom, {
                    type: 'client_left_room',
                    clientId: client.id,
                    roomId: oldRoom
                }, client.id);
            }
            break;
            
        case 'broadcast':
            const sentCount = broadcastToAll({
                type: 'broadcast_message',
                from: client.id,
                fromType: client.type,
                data: data.data,
                timestamp: new Date().toISOString()
            }, client.id);
            
            client.send({
                type: 'broadcast_sent',
                sentTo: sentCount
            });
            break;
            
        case 'room_broadcast':
            if (client.room) {
                const sentCount = broadcastToRoom(client.room, {
                    type: 'room_message',
                    from: client.id,
                    fromType: client.type,
                    roomId: client.room,
                    data: data.data,
                    timestamp: new Date().toISOString()
                }, client.id);
                
                client.send({
                    type: 'room_broadcast_sent',
                    roomId: client.room,
                    sentTo: sentCount
                });
            } else {
                client.send({
                    type: 'error',
                    message: 'Not in any room'
                });
            }
            break;
            
        case 'direct_message':
            // First try to find by clientId
            let targetClient = clients.get(data.targetId);
            
            // If not found by clientId, try to find by clientType
            if (!targetClient) {
                for (const [clientId, client] of clients) {
                    if (client.type === data.targetId) {
                        targetClient = client;
                        break;
                    }
                }
            }
            
            if (targetClient) {
                targetClient.send({
                    type: 'direct_message',
                    from: client.id,
                    fromType: client.type,
                    data: data.data,
                    timestamp: new Date().toISOString()
                });
                
                client.send({
                    type: 'direct_message_sent',
                    targetId: data.targetId
                });
            } else {
                client.send({
                    type: 'error',
                    message: 'Target client not found'
                });
            }
            break;
            
        case 'ping':
            client.send({
                type: 'pong',
                timestamp: new Date().toISOString()
            });
            break;
            
        default:
            client.send({
                type: 'error',
                message: 'Unknown message type'
            });
    }
}

// HTTP API Routes
app.get('/', (req, res) => {
    res.json({
        name: 'Bridge Server',
        version: '1.0.0',
        status: 'running',
        endpoints: {
            websocket: `ws://localhost:${WS_PORT}`,
            websocket_secure: `wss://localhost:${WSS_PORT}`,
            api: `http://localhost:${HTTP_PORT}/api`
        },
        stats: {
            connectedClients: clients.size,
            activeRooms: rooms.size
        }
    });
});

app.get('/api/status', (req, res) => {
    res.json({
        status: 'running',
        timestamp: new Date().toISOString(),
        stats: {
            connectedClients: clients.size,
            activeRooms: rooms.size,
            clientTypes: {
                printer: getClientsByType('printer').length,
                web: getClientsByType('web').length,
                mobile: getClientsByType('mobile').length,
                unknown: getClientsByType('unknown').length
            }
        }
    });
});

app.get('/api/clients', (req, res) => {
    const clientList = [];
    clients.forEach((client, clientId) => {
        clientList.push({
            id: clientId,
            type: client.type,
            room: client.room,
            metadata: client.metadata,
            lastPing: client.lastPing,
            connected: client.ws.readyState === WebSocket.OPEN
        });
    });
    res.json(clientList);
});

app.get('/api/rooms', (req, res) => {
    const roomList = [];
    rooms.forEach((clientIds, roomId) => {
        const roomClients = Array.from(clientIds).map(clientId => {
            const client = clients.get(clientId);
            return client ? {
                id: clientId,
                type: client.type,
                metadata: client.metadata
            } : null;
        }).filter(Boolean);
        
        roomList.push({
            id: roomId,
            clientCount: clientIds.size,
            clients: roomClients
        });
    });
    res.json(roomList);
});

app.post('/api/broadcast', (req, res) => {
    const { data, excludeClientId } = req.body;
    const sentCount = broadcastToAll({
        type: 'api_broadcast',
        data: data,
        timestamp: new Date().toISOString()
    }, excludeClientId);
    
    res.json({
        success: true,
        sentTo: sentCount
    });
});

app.post('/api/room/:roomId/broadcast', (req, res) => {
    const { roomId } = req.params;
    const { data, excludeClientId } = req.body;
    
    const sentCount = broadcastToRoom(roomId, {
        type: 'api_room_broadcast',
        roomId: roomId,
        data: data,
        timestamp: new Date().toISOString()
    }, excludeClientId);
    
    res.json({
        success: true,
        roomId: roomId,
        sentTo: sentCount
    });
});

// Start servers
function startServers() {
    // HTTP Server
    const httpServer = http.createServer(app);
    httpServer.listen(HTTP_PORT, () => {
        console.log(`🌐 HTTP Server running on http://localhost:${HTTP_PORT}`);
    });
    
    // WebSocket Server (WS)
    const wsServer = http.createServer();
    createWebSocketServer(wsServer, false);
    wsServer.listen(WS_PORT, () => {
        console.log(`🔗 WebSocket Server (WS) running on ws://localhost:${WS_PORT}`);
    });
    
    // WebSocket Secure Server (WSS)
    try {
        const keyPath = path.join(__dirname, '..', 'key.pem');
        const certPath = path.join(__dirname, '..', 'cert.pem');
        
        if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
            const serverOptions = {
                key: fs.readFileSync(keyPath),
                cert: fs.readFileSync(certPath)
            };
            
            const wssServer = https.createServer(serverOptions);
            createWebSocketServer(wssServer, true);
            wssServer.listen(WSS_PORT, () => {
                console.log(`🔒 WebSocket Secure Server (WSS) running on wss://localhost:${WSS_PORT}`);
            });
        } else {
            console.log('⚠️  SSL certificates not found. WSS server not started.');
            console.log('   Run "node ../generate-cert.js" to create certificates.');
        }
    } catch (error) {
        console.error('❌ Failed to start WSS server:', error.message);
    }
}

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down Bridge Server...');
    clients.forEach((client) => {
        client.ws.close();
    });
    process.exit(0);
});

// Start the servers
startServers();

console.log('🚀 Bridge Server started!');
console.log('📊 Access dashboard: http://localhost:3000');
console.log('🔗 WebSocket: ws://localhost:3001');
console.log('🔒 WebSocket Secure: wss://localhost:3002 (if certificates available)');