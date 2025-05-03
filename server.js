const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const app = express();
const server = http.createServer(app);
const io = new Server(server);

const clients = new Map();

io.on('connection', (socket) => {
  let kAddress = null;

  socket.on('register', (addr) => {
    kAddress = addr;
    clients.set(addr, socket);
  });

  socket.on('pair', ({ to, message }) => {
    const target = clients.get(to);
    if (target) {
      target.emit('message', { from: kAddress, message });
    }
  });

  socket.on('disconnect', () => {
    if (kAddress) clients.delete(kAddress);
  });
});

server.listen(3000, () => {
  console.log('KQSP server running on port 3000');
});
