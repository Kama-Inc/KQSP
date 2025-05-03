const socket = io("https://kama-inc.github.io/KQSP/"); // replace with real URL
const kaddr = `K(${Math.floor(Math.random()*256)}.${Math.floor(Math.random()*256)}.${Math.floor(Math.random()*256)}.${Math.floor(Math.random()*256)})`;

document.getElementById("kaddr").textContent = kaddr;
socket.emit("register", kaddr);

socket.on("message", ({ from, message }) => {
  const div = document.createElement("div");
  div.textContent = `${from}: ${message}`;
  document.getElementById("messages").appendChild(div);
});

function sendMessage() {
  const to = document.getElementById("peer").value;
  const message = document.getElementById("message").value;
  socket.emit("pair", { to, message });
}
