import random
import hashlib
import json
import socket
import threading
import sys
import time
from queue import Queue

# --- K(addr) Generation ---
def generate_k_addr():
    """Generates a unique K(addr) ID and display string."""
    parts = [random.randint(0, 255) for _ in range(4)]
    display = '.'.join(map(str, parts))
    # PeerJS compatible ID uses hyphens
    peer_id = '-'.join(map(str, parts))
    return display, peer_id

# --- Global State ---
MY_DISPLAY_ADDR, MY_PEER_ID = generate_k_addr()
connections = {} # peer_id -> socket
message_queue = Queue() # Queue for received messages to be printed
group_key = None
listener_socket = None
LISTENING_PORT = 61757 # Arbitrary port, change if needed
stop_event = threading.Event()

def update_group_key():
    """Updates the group key based on connected peers."""
    global group_key
    peer_ids = sorted([MY_PEER_ID] + list(connections.keys()))
    hasher = hashlib.sha256()
    hasher.update(json.dumps(peer_ids).encode('utf-8'))
    group_key = hasher.digest()
    # print(f"[Debug] Group key updated based on: {peer_ids}")

def xor_crypt(data_bytes, key_bytes):
    """Encrypts/decrypts data using XOR with the key."""
    key_len = len(key_bytes)
    return bytes([b ^ key_bytes[i % key_len] for i, b in enumerate(data_bytes)])

def handle_client(conn_socket, addr, peer_id):
    """Handles incoming data from a connected peer."""
    global connections
    print(f"\n[System] Connection established with {peer_id} ({addr})")
    connections[peer_id] = conn_socket
    update_group_key()

    try:
        while not stop_event.is_set():
            # Simple framing: first 4 bytes = length of message
            len_bytes = conn_socket.recv(4)
            if not len_bytes:
                break # Connection closed
            msg_len = int.from_bytes(len_bytes, 'big')
            if msg_len == 0:
                continue

            data = b''
            while len(data) < msg_len:
                chunk = conn_socket.recv(min(msg_len - len(data), 4096))
                if not chunk:
                    raise ConnectionError("Connection broken during message receive")
                data += chunk

            try:
                payload = json.loads(data.decode('utf-8'))
                if payload.get('type') == 'text':
                    encrypted_text_bytes = payload['text'].encode('latin-1') # Use latin-1 to preserve byte values
                    decrypted_bytes = xor_crypt(encrypted_text_bytes, group_key)
                    message_queue.put(f"{payload['from']}: {decrypted_bytes.decode('utf-8')}")
                # Add handlers for 'file', 'audio' etc. later
                elif payload.get('type') == 'hello': # Handle initial handshake
                    pass # Already handled peer_id association
                else:
                    message_queue.put(f"[System] Received unknown message type from {peer_id}: {payload.get('type')}")
            except (json.JSONDecodeError, UnicodeDecodeError, KeyError) as e:
                message_queue.put(f"[System] Error processing message from {peer_id}: {e}")
                message_queue.put(f"[System] Raw data: {data[:100]}...") # Log raw data for debugging

    except ConnectionResetError:
        print(f"\n[System] Connection reset by {peer_id}")
    except ConnectionAbortedError:
        print(f"\n[System] Connection aborted by {peer_id}")
    except Exception as e:
        print(f"\n[System] Error with connection {peer_id}: {e}")
    finally:
        print(f"\n[System] Disconnecting from {peer_id}")
        if peer_id in connections:
            del connections[peer_id]
        update_group_key()
        try:
            conn_socket.close()
        except Exception:
            pass # Ignore errors during close

def start_listener():
    """Starts listening for incoming peer connections."""
    global listener_socket
    listener_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener_socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        listener_socket.bind(('0.0.0.0', LISTENING_PORT))
        listener_socket.listen(5)
        print(f"[System] Listening for connections on port {LISTENING_PORT}...")
        while not stop_event.is_set():
            try:
                # Set a timeout to allow checking stop_event periodically
                listener_socket.settimeout(1.0)
                conn, addr = listener_socket.accept()
                listener_socket.settimeout(None) # Reset timeout after accept

                # Simple handshake: expect a 'hello' message with peer_id
                # This is basic, needs more robust error handling
                hello_data = conn.recv(1024)
                try:
                    hello_payload = json.loads(hello_data.decode('utf-8'))
                    if hello_payload.get('type') == 'hello' and 'peer_id' in hello_payload:
                        peer_id = hello_payload['peer_id']
                        client_thread = threading.Thread(target=handle_client, args=(conn, addr, peer_id), daemon=True)
                        client_thread.start()
                    else:
                        print(f"[System] Invalid handshake from {addr}. Closing.")
                        conn.close()
                except (json.JSONDecodeError, UnicodeDecodeError, KeyError):
                    print(f"[System] Failed handshake from {addr}. Closing.")
                    conn.close()

            except socket.timeout:
                continue # Loop back to check stop_event
            except OSError as e:
                if stop_event.is_set():
                    print("[System] Listener socket closed.")
                    break
                else:
                    print(f"[System] Listener error: {e}")
                    break # Exit if a non-timeout error occurs
            except Exception as e:
                print(f"[System] Error accepting connection: {e}")
                time.sleep(1) # Avoid busy-looping on errors

    except OSError as e:
        print(f"[Error] Could not bind to port {LISTENING_PORT}: {e}")
        print("Please check if the port is already in use or if you have permissions.")
        stop_event.set() # Signal other threads to stop
    finally:
        if listener_socket:
            try:
                listener_socket.close()
            except Exception:
                pass
        print("[System] Listener stopped.")

def connect_to_peer(target_addr_str):
    """Connects to a target peer address (IP:Port or just IP)."""
    global connections
    try:
        if ':' in target_addr_str:
            target_ip, target_port = target_addr_str.split(':')
            target_port = int(target_port)
        else:
            target_ip = target_addr_str
            target_port = LISTENING_PORT # Assume default port

        print(f"[System] Attempting to connect to {target_ip}:{target_port}...")
        conn_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        conn_socket.settimeout(5.0) # 5 second connection timeout
        conn_socket.connect((target_ip, target_port))
        conn_socket.settimeout(None)

        # Send handshake
        hello_payload = json.dumps({'type': 'hello', 'peer_id': MY_PEER_ID}).encode('utf-8')
        conn_socket.sendall(hello_payload)

        # Need the target's peer_id - how to get it? Assume it's sent back or known?
        # For now, we can't add to connections properly without their ID.
        # Let's modify handle_client to expect the ID *first*.
        # This requires a protocol change - simpler for now: just start handling data.
        # We need a way to map IP:Port back to a K(addr)-like ID.
        # Let's use IP:Port as a temporary ID until a better handshake is done.
        temp_peer_id = f"{target_ip}:{target_port}"
        connections[temp_peer_id] = conn_socket
        update_group_key()

        client_thread = threading.Thread(target=handle_client, args=(conn_socket, (target_ip, target_port), temp_peer_id), daemon=True)
        client_thread.start()
        print(f"[System] Connection initiated with {temp_peer_id}")
        return True

    except socket.timeout:
        print(f"[Error] Connection to {target_addr_str} timed out.")
        return False
    except ConnectionRefusedError:
        print(f"[Error] Connection to {target_addr_str} refused. Is the peer running and listening?")
        return False
    except Exception as e:
        print(f"[Error] Failed to connect to {target_addr_str}: {e}")
        return False

def send_message(text):
    """Encrypts and sends a text message to all connected peers."""
    if not connections:
        print("[System] No active connections to send message.")
        return
    if not group_key:
        print("[System] Group key not yet established. Cannot send message.")
        return

    encrypted_bytes = xor_crypt(text.encode('utf-8'), group_key)
    payload = {
        'type': 'text',
        'from': f"K({MY_DISPLAY_ADDR})",
        'text': encrypted_bytes.decode('latin-1') # Use latin-1 to preserve byte values
    }
    payload_bytes = json.dumps(payload).encode('utf-8')
    len_bytes = len(payload_bytes).to_bytes(4, 'big')

    disconnected_peers = []
    for peer_id, conn_socket in list(connections.items()):
        try:
            conn_socket.sendall(len_bytes + payload_bytes)
        except (ConnectionResetError, BrokenPipeError, OSError) as e:
            print(f"\n[System] Failed to send to {peer_id}: {e}. Removing connection.")
            disconnected_peers.append(peer_id)
        except Exception as e:
             print(f"\n[System] Unexpected error sending to {peer_id}: {e}. Removing connection.")
             disconnected_peers.append(peer_id)

    if disconnected_peers:
        for peer_id in disconnected_peers:
            if peer_id in connections:
                try:
                    connections[peer_id].close()
                except Exception:
                    pass
                del connections[peer_id]
        update_group_key()

def print_messages():
    """Prints messages from the queue."""
    while not stop_event.is_set():
        try:
            msg = message_queue.get(timeout=0.1)
            # Clear current line, print message, then reprint prompt
            sys.stdout.write('\r' + ' ' * 80 + '\r') # Clear line
            print(msg)
            sys.stdout.write("Enter message or command (/connect <ip:port>, /quit): ")
            sys.stdout.flush()
            message_queue.task_done()
        except Queue.Empty:
            continue
        except Exception as e:
            print(f"\n[System] Error printing message: {e}")

def main():
    print("--- Kazan's Quick Share Protocol (CLI) ---")
    print(f"Your Address: K({MY_DISPLAY_ADDR}) (PeerID: {MY_PEER_ID})")
    print(f"Your Peer Address for others to connect: [Your IP]:{LISTENING_PORT}")
    print("-------------------------------------------")

    listener_thread = threading.Thread(target=start_listener, daemon=True)
    listener_thread.start()

    printer_thread = threading.Thread(target=print_messages, daemon=True)
    printer_thread.start()

    time.sleep(0.5) # Allow listener to start
    if stop_event.is_set(): # Check if listener failed to bind
        print("[System] Exiting due to listener error.")
        return

    try:
        while not stop_event.is_set():
            try:
                user_input = input("Enter message or command (/connect <ip:port>, /quit): ")
                if user_input.startswith('/connect '):
                    target = user_input.split(' ', 1)[1].strip()
                    if target:
                        connect_to_peer(target)
                    else:
                        print("[System] Usage: /connect <ip_address[:port]>" )
                elif user_input == '/quit':
                    print("[System] Quitting...")
                    stop_event.set()
                    break
                elif user_input.startswith('/'):
                    print(f"[System] Unknown command: {user_input.split(' ')[0]}")
                elif user_input:
                    send_message(user_input)
                # Allow loop to process received messages if input is empty

            except EOFError:
                print("\n[System] EOF detected. Quitting...")
                stop_event.set()
                break
            except KeyboardInterrupt:
                print("\n[System] Keyboard interrupt detected. Quitting...")
                stop_event.set()
                break
            except Exception as e:
                print(f"\n[System] Error in main loop: {e}")
                time.sleep(1)

    finally:
        print("[System] Cleaning up...")
        stop_event.set()
        if listener_socket:
            try:
                # Unblock listener accept() call if it's waiting
                # This might not work reliably on all platforms
                with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                    s.connect(('127.0.0.1', LISTENING_PORT))
            except Exception:
                pass # Ignore if connection fails (socket might be closed)
            try:
                 listener_socket.close()
            except Exception:
                 pass

        for peer_id, conn_socket in list(connections.items()):
            try:
                conn_socket.close()
            except Exception:
                pass

        # Wait briefly for threads to notice stop_event
        listener_thread.join(timeout=2)
        printer_thread.join(timeout=1)
        print("[System] Exited.")

if __name__ == "__main__":
    main()