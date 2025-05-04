import asyncio
import json
import random
import hashlib
import sys
import ssl
import logging
import os
from aiortc import RTCIceCandidate, RTCPeerConnection, RTCSessionDescription, MediaStreamTrack
from aiortc.contrib.signaling import BYE, add_signaling_arguments, create_signaling

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

# --- Main Application Logic ---
async def run(pc, signaling, role):
    """Main coroutine for handling a single peer connection."""
    connected_peer_ids = set()

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
        await message_queue.put(f"[System] Connection state with {peer_id} is {pc.connectionState}")
        if pc.connectionState == "failed" or pc.connectionState == "closed" or pc.connectionState == "disconnected":
            await signaling.send(BYE)
            if pc in pcs:
                pcs.discard(pc)
            connected_peer_ids.discard(peer_id)
            update_group_key(connected_peer_ids)
            await pc.close()
        elif pc.connectionState == "connected":
             connected_peer_ids.add(peer_id)
             update_group_key(connected_peer_ids)

    @pc.on("track")
    def on_track(track):
        # KQSP doesn't use media tracks currently, but handle gracefully
        @track.on("ended")
        async def on_ended():
             await message_queue.put(f"[System] Track {track.kind} ended")

    # Connect signaling
    await signaling.connect()

    if role == "offer":
        # Create data channel
        channel = pc.createDataChannel("kqsp-chat")
        peer_id = "offering-peer" # Placeholder until connected
        asyncio.create_task(handle_data_channel(channel, peer_id))

        # Send offer
        await pc.setLocalDescription(await pc.createOffer())
        await signaling.send(pc.localDescription)
        await message_queue.put("[System] Sent offer...")

    # Consume signaling
    while True:
        try:
            obj = await signaling.receive()

            if isinstance(obj, RTCSessionDescription):
                await pc.setRemoteDescription(obj)
                peer_id = get_peer_id(pc)
                await message_queue.put(f"[System] Received remote description from {peer_id}")

                if obj.type == "offer":
                    # Create data channel if answering
                    # Note: on_datachannel handles channel creation initiated by remote peer
                    # Send answer
                    await pc.setLocalDescription(await pc.createAnswer())
                    await signaling.send(pc.localDescription)
                    await message_queue.put("[System] Sent answer...")
            elif isinstance(obj, RTCIceCandidate):
                await pc.addIceCandidate(obj)
                # await message_queue.put("[System] Added ICE candidate") # Too verbose
            elif obj is BYE:
                await message_queue.put("[System] Received BYE, closing connection")
                break
            else:
                await message_queue.put(f"[System] Received unknown signaling object: {type(obj)}")
        except asyncio.CancelledError:
            break
        except Exception as e:
            await message_queue.put(f"[System] Error during signaling: {e}")
            break

    await message_queue.put("[System] Signaling loop ended.")

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
    print(f"Signaling Server: {args.signaling_host}:{args.signaling_port}")
    print("Connecting to signaling server...")
    print("--------------------------------------------------")

    # Create signaling instance
    # Note: This basic example uses aiortc's built-in TCP signaling.
    # For web compatibility, a WebSocket signaling server (like PeerJS server or custom) is needed.
    signaling = create_signaling(args)

    # Create peer connection
    pc = RTCPeerConnection()
    pcs.add(pc)

    # Start background tasks
    print_task = asyncio.create_task(print_messages())
    input_task = asyncio.create_task(consume_user_input())

    # Run main connection logic
    try:
        await run(pc=pc, signaling=signaling, role=args.role)
    except Exception as e:
        print(f"[System] Main execution error: {e}")
    finally:
        print("[System] Cleaning up...")
        stop_event.set()

        # Close signaling and connections
        await signaling.close()
        coros = [pc.close() for pc in pcs]
        await asyncio.gather(*coros)
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

    # Add signaling arguments (host, port, role)
    parser = add_signaling_arguments()
    # Add any KQSP specific arguments here if needed
    args = parser.parse_args()

    # SSL context (optional, depends on signaling server)
    # ssl_context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    # ssl_context.load_verify_locations(cert_file)

    try:
        asyncio.run(main(args))
    except KeyboardInterrupt:
        pass