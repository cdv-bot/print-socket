const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

// Express app setup
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Store connected clients
const clients = new Map();
const rooms = new Map();

// Client class
class Client {
    constructor(ws, id, type = 'unknown') {
        this.id = id;
        this.ws = ws;
        this.type = type; 
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
        if (this.room) this.leaveRoom();
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

// Utils
function broadcastToRoom(roomId, data, excludeClientId = null) {
    if (!rooms.has(roomId)) return 0;
    let sentCount = 0;
    rooms.get(roomId).forEach(clientId => {
        if (clientId !== excludeClientId && clients.has(clientId)) {
            const client = clients.get(clientId);
            if (client.send(data)) sentCount++;
        }
    });
    return sentCount;
}

function broadcastToAll(data, excludeClientId = null) {
    let sentCount = 0;
    clients.forEach((client, clientId) => {
        if (clientId !== excludeClientId) {
            if (client.send(data)) sentCount++;
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

// WebSocket server
function createWebSocketServer(server) {
    const wss = new WebSocket.Server({ server });
    
    wss.on('connection', (ws) => {
        const clientId = uuidv4();
        const client = new Client(ws, clientId);
        clients.set(clientId, client);
        
        console.log(`🔗 Client connected: ${clientId}`);
        
        client.send({
            type: 'welcome',
            clientId: clientId,
            message: 'Connected to Bridge Server',
            serverInfo: {
                timestamp: new Date().toISOString()
            }
        });
        
        ws.on('message', (message) => {
            try {
                const data = JSON.parse(message);
                handleMessage(client, data);
            } catch (error) {
                console.error('❌ Invalid JSON:', error);
                client.send({ type: 'error', message: 'Invalid JSON format' });
            }
        });
        
        ws.on('close', () => {
            console.log(`🔌 Client disconnected: ${clientId}`);
            client.leaveRoom();
            clients.delete(clientId);
            broadcastToAll({ type: 'client_disconnected', clientId: clientId }, clientId);
        });
        
        ws.on('error', (error) => {
            console.error(`❌ WebSocket error for ${clientId}:`, error);
        });
        
        // Ping check
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
}

// Message handling
function handleMessage(client, data) {
    console.log(`📨 Message from ${client.id}:`, data);
    
    switch (data.type) {
        case 'register':
            client.type = data.clientType || 'unknown';
            client.metadata = data.metadata || {};
            client.send({ type: 'registered', clientId: client.id, clientType: client.type });
            broadcastToAll({ type: 'client_registered', clientId: client.id, clientType: client.type, metadata: client.metadata }, client.id);
            break;
            
        case 'join_room':
            client.joinRoom(data.roomId);
            client.send({ type: 'room_joined', roomId: data.roomId });
            broadcastToRoom(data.roomId, { type: 'client_joined_room', clientId: client.id, clientType: client.type, roomId: data.roomId }, client.id);
            break;
            
        case 'leave_room':
            const oldRoom = client.room;
            client.leaveRoom();
            client.send({ type: 'room_left', roomId: oldRoom });
            if (oldRoom) {
                broadcastToRoom(oldRoom, { type: 'client_left_room', clientId: client.id, roomId: oldRoom }, client.id);
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
            client.send({ type: 'broadcast_sent', sentTo: sentCount });
            break;
            
        case 'room_broadcast':
            if (client.room) {
                const sent = broadcastToRoom(client.room, {
                    type: 'room_message',
                    from: client.id,
                    fromType: client.type,
                    roomId: client.room,
                    data: data.data,
                    timestamp: new Date().toISOString()
                }, client.id);
                client.send({ type: 'room_broadcast_sent', roomId: client.room, sentTo: sent });
            } else {
                client.send({ type: 'error', message: 'Not in any room' });
            }
            break;
            
        case 'direct_message':
            let targetClient = clients.get(data.targetId);
            if (!targetClient) {
                for (const [clientId, c] of clients) {
                    if (c.type === data.targetId) {
                        targetClient = c;
                        break;
                    }
                }
            }
            if (targetClient) {
                targetClient.send({ type: 'direct_message', from: client.id, fromType: client.type, data: data.data, timestamp: new Date().toISOString() });
                client.send({ type: 'direct_message_sent', targetId: data.targetId });
            } else {
                client.send({ type: 'error', message: 'Target client not found' });
            }
            break;
            
        case 'ping':
            client.send({ type: 'pong', timestamp: new Date().toISOString() });
            break;
            
        default:
            client.send({ type: 'error', message: 'Unknown message type' });
    }
}

// HTTP routes
app.get('/', (req, res) => {
    res.json({
        name: 'Bridge Server',
        version: '1.0.0',
        status: 'running',
        websocket: `wss://${req.headers.host}`,
        api: `https://${req.headers.host}/api`,
        stats: { connectedClients: clients.size, activeRooms: rooms.size }
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
            return client ? { id: clientId, type: client.type, metadata: client.metadata } : null;
        }).filter(Boolean);
        roomList.push({ id: roomId, clientCount: clientIds.size, clients: roomClients });
    });
    res.json(roomList);
});

app.post('/api/broadcast', (req, res) => {
    const { data, excludeClientId } = req.body;
    const sentCount = broadcastToAll({ type: 'api_broadcast', data, timestamp: new Date().toISOString() }, excludeClientId);
    res.json({ success: true, sentTo: sentCount });
});

app.post('/api/room/:roomId/broadcast', (req, res) => {
    const { roomId } = req.params;
    const { data, excludeClientId } = req.body;
    const sentCount = broadcastToRoom(roomId, { type: 'api_room_broadcast', roomId, data, timestamp: new Date().toISOString() }, excludeClientId);
    res.json({ success: true, roomId, sentTo: sentCount });
});

// Start server
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);
createWebSocketServer(server);

server.listen(PORT, () => {
    console.log(`🚀 Server listening on port ${PORT}`);
});
