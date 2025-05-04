import asyncio
import json
import random
import hashlib
import sys
import ssl
import logging
import os
import argparse
from urllib.parse import urlparse # <-- Add this

from aiortc import RTCIceCandidate, RTCPeerConnection, RTCSessionDescription, MediaStreamTrack
# Use specific signaling classes instead of the helper function
from aiortc.contrib.signaling import BYE, CopyAndPasteSignaling, TcpSocketSignaling, UnixSocketSignaling
# Import WebSocket signaling (assuming a basic implementation or one compatible with PeerJS server)
# You might need a more specific implementation depending on the server
from aiortc.contrib.signaling import add_signaling_arguments as basic_add_signaling_arguments
from aiortc.contrib.signaling import create_signaling as basic_create_signaling
# Let's try using a generic WebSocket approach first, might need refinement
# from aiortc.contrib.signaling import Signalling # Base class, might need custom implementation <-- REMOVE THIS LINE
import aiohttp # Need aiohttp for WebSocket client


# --- K(addr) Generation & Global State ---
def generate_k_addr():
    """Generates a unique K(addr) ID and display string."""
    parts = [random.randint(0, 255) for _ in range(4)]
    display = '.'.join(map(str, parts))
    peer_id = '-'.join(map(str, parts))
    return display, peer_id

MY_DISPLAY_ADDR, MY_PEER_ID = generate_k_addr()
ROOT = os.path.dirname(__file__)
cert_file = os.path.join(ROOT, "cert.pem") # Placeholder for potential cert
key_file = os.path.join(ROOT, "key.pem")   # Placeholder for potential key

pcs = set() # Set of active RTCPeerConnection objects
group_key = None
message_queue = asyncio.Queue() # Async queue for received messages
stop_event = asyncio.Event()

# --- Group Key & Encryption (Same as before) ---
def update_group_key(connected_peer_ids):
    """Updates the group key based on connected peers."""
    global group_key
    peer_ids = sorted([MY_PEER_ID] + list(connected_peer_ids))
    hasher = hashlib.sha256()
    hasher.update(json.dumps(peer_ids).encode('utf-8'))
    group_key = hasher.digest()
    # print(f"[Debug] Group key updated based on: {peer_ids}")

def xor_crypt(data_bytes, key_bytes):
    """Encrypts/decrypts data using XOR with the key."""
    if not key_bytes:
        return data_bytes # No encryption if key is not set
    key_len = len(key_bytes)
    return bytes([b ^ key_bytes[i % key_len] for i, b in enumerate(data_bytes)])

# --- WebRTC Data Channel Handling ---
async def handle_data_channel(channel, peer_id):
    """Handles messages received on a data channel."""
    await message_queue.put(f"[System] Data channel '{channel.label}' created with {peer_id}")
    update_group_key({pc.remoteDescription.sdp.split('o=')[1].split(' ')[0] for pc in pcs if pc.remoteDescription}) # Update key on new channel

    @channel.on("message")
    async def on_message(message):
        try:
            # Assume message is JSON payload as string
            payload = json.loads(message)
            if payload.get('type') == 'text':
                encrypted_text_bytes = payload['text'].encode('latin-1')
                decrypted_bytes = xor_crypt(encrypted_text_bytes, group_key)
                await message_queue.put(f"{payload['from']}: {decrypted_bytes.decode('utf-8')}")
            # Add handlers for 'file', 'audio' later
            else:
                await message_queue.put(f"[System] Received unknown message type from {peer_id}: {payload.get('type')}")
        except (json.JSONDecodeError, UnicodeDecodeError, KeyError, AttributeError) as e:
            await message_queue.put(f"[System] Error processing message from {peer_id} on channel {channel.label}: {e}")
            # Log raw message for debugging if not JSON
            if isinstance(message, str):
                 await message_queue.put(f"[System] Raw data: {message[:100]}...")
            else:
                 await message_queue.put(f"[System] Received non-string data: {type(message)}")

    @channel.on("close")
    async def on_close():
        await message_queue.put(f"[System] Data channel '{channel.label}' closed with {peer_id}")
        # Find the peer connection associated with this channel to remove if needed
        # This part is tricky as channel doesn't directly link back to pc easily
        # We might need to manage connections differently

# --- WebSocket Signaling (Basic Example) ---
# This is a placeholder/example. A robust implementation needs to handle
# the specific message format of your chosen WebSocket signaling server (e.g., PeerJS server).
class WebSocketSignaling: # <-- REMOVE INHERITANCE
    def __init__(self, ws_url, peer_id, peer_role='offer'): # Added peer_id and role
        self._ws_url = ws_url
        self._peer_id = peer_id
        self._peer_role = peer_role # 'offer' or 'answer'
        self._websocket = None
        self._session = None
        self._target_peer_id = None # For direct messaging if needed

    async def connect(self):
        self._session = aiohttp.ClientSession()
        try:
            self._websocket = await self._session.ws_connect(self._ws_url)
            # Register with the server (example, depends on server protocol)
            # PeerJS servers often require an OPEN message with the peer ID
            await self._websocket.send_json({'type': 'OPEN', 'src': self._peer_id})
            # Start listening for messages
            asyncio.create_task(self._receive_loop())
            await message_queue.put(f"[System] WebSocket connected to {self._ws_url} as {self._peer_id}")
        except Exception as e:
            await message_queue.put(f"[System] WebSocket connection failed: {e}")
            if self._session:
                await self._session.close()
            raise

    async def close(self):
        if self._websocket:
            await self._websocket.close()
        if self._session:
            await self._session.close()
        await message_queue.put("[System] WebSocket closed.")

    async def receive(self):
        # This is now handled by the _receive_loop pushing to the main queue or handling internally
        # For simplicity, we'll let the main loop poll the message_queue for signaling messages
        # A better approach would be a dedicated signaling queue or direct calls
        await asyncio.sleep(3600) # Block indefinitely, messages handled in loop

    async def _receive_loop(self):
        try:
            async for msg in self._websocket:
                if msg.type == aiohttp.WSMsgType.TEXT:
                    data = json.loads(msg.data)
                    await message_queue.put(f"[Signal] Received: {data}") # Log raw signal

                    # Basic PeerJS-like message handling (adapt as needed)
                    msg_type = data.get('type')
                    src_peer = data.get('src')
                    dst_peer = data.get('dst')

                    if dst_peer != self._peer_id: # Ignore messages not for us
                        continue

                    if msg_type == 'OFFER':
                        self._target_peer_id = src_peer # Store who sent the offer
                        await pc.setRemoteDescription(RTCSessionDescription(sdp=data['payload']['sdp'], type=data['payload']['type']))
                        # Create and send answer
                        await pc.setLocalDescription(await pc.createAnswer())
                        await self.send(pc.localDescription)
                    elif msg_type == 'ANSWER':
                        await pc.setRemoteDescription(RTCSessionDescription(sdp=data['payload']['sdp'], type=data['payload']['type']))
                    elif msg_type == 'CANDIDATE':
                        candidate_info = data['payload']['candidate']
                        # aiortc needs candidate, sdpMid, sdpMLineIndex
                        candidate = RTCIceCandidate(
                            sdpMid=candidate_info.get('sdpMid'),
                            sdpMLineIndex=candidate_info.get('sdpMLineIndex'),
                            candidate=candidate_info.get('candidate')
                        )
                        await pc.addIceCandidate(candidate)
                    elif msg_type == 'LEAVE': # PeerJS uses LEAVE
                        await message_queue.put(f"[System] Peer {src_peer} left.")
                        # Handle disconnection logic if needed
                        if self._target_peer_id == src_peer:
                             # Potentially close the connection
                             pass
                    elif msg_type == 'EXPIRE': # PeerJS uses EXPIRE
                         await message_queue.put(f"[System] Peer {src_peer} expired.")
                         # Handle disconnection logic

                elif msg.type == aiohttp.WSMsgType.ERROR:
                    await message_queue.put(f"[System] WebSocket connection error: {self._websocket.exception()}")
                    break
        except Exception as e:
            await message_queue.put(f"[System] WebSocket receive loop error: {e}")
        finally:
             await message_queue.put("[System] WebSocket receive loop ended.")
             # Signal main loop to exit or reconnect?
             stop_event.set()

    async def send(self, obj):
        if isinstance(obj, RTCSessionDescription):
            # Send OFFER or ANSWER (PeerJS format)
            payload = {'type': obj.type.upper(), 'sdp': obj.sdp}
            # Need target peer ID - how do we get this? Assume stored from OFFER or arg
            if not self._target_peer_id:
                 # If offering, need to specify target peer ID somehow (e.g., via command line)
                 # This basic example assumes we are answering an offer or target is known
                 await message_queue.put("[System] Cannot send OFFER/ANSWER: Target Peer ID not set.")
                 return
            message = {'type': obj.type.upper(), 'payload': payload, 'dst': self._target_peer_id, 'src': self._peer_id}
            await self._websocket.send_json(message)
            await message_queue.put(f"[Signal] Sent {obj.type.upper()} to {self._target_peer_id}")
        elif isinstance(obj, RTCIceCandidate):
            # Send CANDIDATE (PeerJS format)
            if obj.sdpMid is None:
                 # Skip null candidates often generated at the end
                 return
            payload = {
                'candidate': {
                    'candidate': obj.candidate,
                    'sdpMid': obj.sdpMid,
                    'sdpMLineIndex': obj.sdpMLineIndex,
                },
                'type': 'candidate' # PeerJS seems to use this structure
            }
            if not self._target_peer_id:
                 await message_queue.put("[System] Cannot send CANDIDATE: Target Peer ID not set.")
                 return
            message = {'type': 'CANDIDATE', 'payload': payload, 'dst': self._target_peer_id, 'src': self._peer_id}
            await self._websocket.send_json(message)
            # await message_queue.put(f"[Signal] Sent CANDIDATE to {self._target_peer_id}") # Too verbose
        elif obj is BYE:
            # Send LEAVE (PeerJS format)
            if self._target_peer_id:
                message = {'type': 'LEAVE', 'dst': self._target_peer_id, 'src': self._peer_id}
                await self._websocket.send_json(message)
                await message_queue.put(f"[Signal] Sent LEAVE to {self._target_peer_id}")

# --- WebRTC Data Channel Handling ---
async def handle_data_channel(channel, peer_id):
    """Handles messages received on a data channel."""
    await message_queue.put(f"[System] Data channel '{channel.label}' created with {peer_id}")
    update_group_key({pc.remoteDescription.sdp.split('o=')[1].split(' ')[0] for pc in pcs if pc.remoteDescription}) # Update key on new channel

    @channel.on("message")
    async def on_message(message):
        try:
            # Assume message is JSON payload as string
            payload = json.loads(message)
            if payload.get('type') == 'text':
                encrypted_text_bytes = payload['text'].encode('latin-1')
                decrypted_bytes = xor_crypt(encrypted_text_bytes, group_key)
                await message_queue.put(f"{payload['from']}: {decrypted_bytes.decode('utf-8')}")
            # Add handlers for 'file', 'audio' later
            else:
                await message_queue.put(f"[System] Received unknown message type from {peer_id}: {payload.get('type')}")
        except (json.JSONDecodeError, UnicodeDecodeError, KeyError, AttributeError) as e:
            await message_queue.put(f"[System] Error processing message from {peer_id} on channel {channel.label}: {e}")
            # Log raw message for debugging if not JSON
            if isinstance(message, str):
                 await message_queue.put(f"[System] Raw data: {message[:100]}...")
            else:
                 await message_queue.put(f"[System] Received non-string data: {type(message)}")

    @channel.on("close")
    async def on_close():
        await message_queue.put(f"[System] Data channel '{channel.label}' closed with {peer_id}")
        # Find the peer connection associated with this channel to remove if needed
        # This part is tricky as channel doesn't directly link back to pc easily
        # We might need to manage connections differently

# --- Main Application Logic ---
async def run(pc, signaling, role, target_peer=None): # Added target_peer
    """Main coroutine for handling a single peer connection."""
    connected_peer_ids = set()
    signaling._target_peer_id = target_peer # Pass target to signaling instance

    def get_peer_id(pc_obj):
        if pc_obj and pc_obj.remoteDescription:
            # Attempt to extract peer ID from SDP (this is fragile)
            try:
                return pc_obj.remoteDescription.sdp.split('o=')[1].split(' ')[0]
            except IndexError:
                return "unknown-peer"
        return "unknown-peer"

    async def send_ping():
        # Keepalive or other periodic tasks if needed
        pass

    @pc.on("datachannel")
    async def on_datachannel(channel):
        peer_id = get_peer_id(pc)
        asyncio.create_task(handle_data_channel(channel, peer_id))

    @pc.on("connectionstatechange")
    async def on_connectionstatechange():
        peer_id = get_peer_id(pc)
        state = pc.connectionState
        await message_queue.put(f"[System] Connection state with {peer_id} is {state}")
        if state == "failed" or state == "closed" or state == "disconnected":
            # await signaling.send(BYE) # Let WebSocket loop handle LEAVE
            if pc in pcs:
                pcs.discard(pc)
            if peer_id != "unknown-peer":
                 connected_peer_ids.discard(peer_id)
            update_group_key(connected_peer_ids)
            await pc.close()
            if not pcs: # If no connections left, stop
                 stop_event.set()
        elif state == "connected":
             if peer_id != "unknown-peer":
                 connected_peer_ids.add(peer_id)
             update_group_key(connected_peer_ids)
             await message_queue.put(f"[System] Connected to {peer_id}!")

    # Connect signaling
    await signaling.connect()

    if role == "offer":
        # Create data channel
        channel = pc.createDataChannel("kqsp-chat") # Use same label as web
        peer_id = target_peer if target_peer else "offering-peer"
        asyncio.create_task(handle_data_channel(channel, peer_id))

        # Send offer
        await pc.setLocalDescription(await pc.createOffer())
        await signaling.send(pc.localDescription)
        await message_queue.put(f"[System] Sent offer to {target_peer}...")

    # Wait for connection or stop signal
    await stop_event.wait()
    await message_queue.put("[System] Main loop exiting due to stop event.")

# --- User Input and Message Sending ---
async def consume_user_input():
    """Handles user input from stdin."""
    loop = asyncio.get_event_loop()
    while not stop_event.is_set():
        try:
            # Use run_in_executor for blocking input()
            user_input = await loop.run_in_executor(
                None, lambda: input("Enter message or command (/quit): ")
            )
            if user_input == '/quit':
                await message_queue.put("[System] Quitting...")
                stop_event.set()
                break
            elif user_input.startswith('/'):
                await message_queue.put(f"[System] Unknown command: {user_input.split(' ')[0]}")
            elif user_input:
                await send_cli_message(user_input)
        except (EOFError, KeyboardInterrupt):
            await message_queue.put("\n[System] Input interrupted. Quitting...")
            stop_event.set()
            break
        except Exception as e:
            await message_queue.put(f"\n[System] Error reading input: {e}")
            await asyncio.sleep(1)

async def send_cli_message(text):
    """Encrypts and sends a text message to all connected peers via data channels."""
    if not pcs:
        await message_queue.put("[System] No active connections to send message.")
        return
    if not group_key:
        await message_queue.put("[System] Group key not yet established. Cannot send message.")
        return

    encrypted_bytes = xor_crypt(text.encode('utf-8'), group_key)
    payload = {
        'type': 'text',
        'from': f"K({MY_DISPLAY_ADDR})",
        'text': encrypted_bytes.decode('latin-1') # Use latin-1 to preserve byte values
    }
    message_str = json.dumps(payload)

    sent_to_any = False
    failed_pcs = set()
    for pc in pcs:
        # Find the 'kqsp-chat' data channel (or similar)
        channel = next((c for c in pc.sctp.dataChannels if c.label == 'kqsp-chat' and c.readyState == 'open'), None)
        if channel:
            try:
                channel.send(message_str)
                sent_to_any = True
            except Exception as e:
                peer_id = get_peer_id(pc)
                await message_queue.put(f"[System] Failed to send to {peer_id}: {e}")
                failed_pcs.add(pc)
        else:
            peer_id = get_peer_id(pc)
            await message_queue.put(f"[System] No open 'kqsp-chat' channel found for {peer_id}")
            # Consider closing this pc if channel is missing/closed?
            # failed_pcs.add(pc)

    if sent_to_any:
         await message_queue.put(f"You: {text}") # Show own message
    else:
         await message_queue.put("[System] Message could not be sent to any peer.")

    # Clean up failed connections
    # for pc in failed_pcs:
    #     if pc in pcs:
    #         await message_queue.put(f"[System] Closing failed connection {get_peer_id(pc)}")
    #         pcs.discard(pc)
    #         await pc.close()

# --- Message Printing --- #
async def print_messages():
    """Prints messages from the async queue."""
    while not stop_event.is_set():
        try:
            msg = await asyncio.wait_for(message_queue.get(), timeout=0.1)
            # Simple print for now, could clear line like before if needed
            print(msg)
            message_queue.task_done()
        except asyncio.TimeoutError:
            continue
        except Exception as e:
            print(f"\n[System] Error printing message: {e}")

# --- Main Execution --- #
async def main(args):
    print("--- Kazan's Quick Share Protocol (CLI - WebRTC) ---")
    print(f"Your PeerID: {MY_PEER_ID}")

    # Create signaling instance based on args
    if args.signaling_url:
        print(f"Signaling Server (WebSocket): {args.signaling_url}")
        # Determine role based on whether target_peer is provided
        role = 'offer' if args.target_peer else 'answer'
        print(f"Role: {role}" + (f" (Target: {args.target_peer})" if role == 'offer' else ""))
        signaling = WebSocketSignaling(args.signaling_url, MY_PEER_ID, role)
    else:
        # Fallback to basic signaling if no URL provided
        print(f"Signaling Server (Basic): {args.signaling} {args.signaling_host}:{args.signaling_port}")
        print(f"Role: {args.role}")
        signaling = basic_create_signaling(args)
        role = args.role

    print("Connecting to signaling server...")
    print("--------------------------------------------------")

    # Create peer connection
    # Need global pc for WebSocket callback access, or pass it differently
    global pc
    pc = RTCPeerConnection()
    pcs.add(pc)

    # Start background tasks
    print_task = asyncio.create_task(print_messages())
    input_task = asyncio.create_task(consume_user_input())

    # Run main connection logic
    try:
        await run(pc=pc, signaling=signaling, role=role, target_peer=args.target_peer if args.signaling_url else None)
    except Exception as e:
        print(f"[System] Main execution error: {e}")
    finally:
        print("[System] Cleaning up...")
        if not stop_event.is_set():
             stop_event.set() # Ensure stop event is set on exit

        # Close signaling and connections
        await signaling.close()
        coros = [p.close() for p in pcs]
        await asyncio.gather(*coros, return_exceptions=True)
        pcs.clear()

        # Cancel background tasks
        input_task.cancel()
        print_task.cancel()
        try:
            await input_task
        except asyncio.CancelledError:
            pass
        try:
            await print_task
        except asyncio.CancelledError:
            pass

    print("[System] Exited.")

if __name__ == "__main__":
    # Setup logging
    logging.basicConfig(level=logging.INFO)
    logging.getLogger("aiortc").setLevel(logging.WARNING)
    logging.getLogger("aioice").setLevel(logging.WARNING)
    logging.getLogger("aiohttp").setLevel(logging.WARNING) # Quiet aiohttp

    # Create argument parser
    parser = argparse.ArgumentParser(description="KQSP CLI with WebRTC")

    # Add signaling arguments (host, port, role) - keep basic for fallback
    # basic_add_signaling_arguments(parser)
    # Instead, add specific arguments
    parser.add_argument('--role', choices=['offer', 'answer'], default='answer', help='Role for basic signaling (offer or answer)')
    parser.add_argument('--signaling', '-s', choices=['copy-and-paste', 'tcp-socket', 'unix-socket'], default='tcp-socket', help='Basic signaling type')
    parser.add_argument('--signaling-host', default='127.0.0.1', help='Signaling host for tcp-socket')
    parser.add_argument('--signaling-port', type=int, default=8080, help='Signaling port for tcp-socket')
    parser.add_argument('--signaling-path', default='aiortc.socket', help='Signaling path for unix-socket')

    # Add WebSocket signaling arguments
    parser.add_argument('--signaling-url', help='URL of the WebSocket signaling server (e.g., wss://host:port/path)')
    parser.add_argument('--target-peer', help='Peer ID to connect to when offering via WebSocket')

    # Add any KQSP specific arguments here if needed
    # parser.add_argument('--my-arg', help='Example KQSP argument')

    args = parser.parse_args()

    # Validate: If using WebSocket, role is determined by target_peer
    if args.signaling_url and not args.target_peer:
        args.role = 'answer' # Default to answer if URL given but no target
    elif args.signaling_url and args.target_peer:
        args.role = 'offer'

    # Validate: Target peer is required for offering via WebSocket
    if args.signaling_url and args.role == 'offer' and not args.target_peer:
        parser.error("Argument --target-peer is required when offering via WebSocket (--signaling-url)")

    # SSL context (optional, depends on signaling server)
    # ssl_context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    # ssl_context.load_verify_locations(cert_file)

    try:
        asyncio.run(main(args))
    except KeyboardInterrupt:
        pass