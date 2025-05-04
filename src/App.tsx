import React, { useState, useEffect, useRef, useCallback } from 'react';
import Peer, { DataConnection } from 'peerjs';
import { Buffer } from 'buffer';
import QRCode from 'qrcode.react'; // For displaying QR code
import { QrReader } from 'react-qr-reader'; // For scanning QR code
import './App.css';

// Polyfill Buffer if needed
window.Buffer = window.Buffer || Buffer;

// --- K(addr) Generation --- (Simplified version for web)
function generateKAddr() {
  const parts = Array.from({ length: 4 }, () => Math.floor(Math.random() * 256));
  const display = parts.join('.');
  // Use a more robust ID generation for production
  const peerId = `kqsp-web-${parts.join('-')}-${Date.now().toString(36).slice(-4)}`;
  return {
    display: `K(${display})`,
    peerId,
  };
}

// Helper for sorting keys
function sorted(arr: string[]): string[] {
  return [...arr].sort();
}

// Web Crypto SHA256 helper
async function sha256(str: string): Promise<Buffer> {
  const buffer = new TextEncoder().encode(str);
  const hashBuffer = await window.crypto.subtle.digest('SHA-256', buffer);
  return Buffer.from(hashBuffer);
}

interface Message {
  id: string;
  from: string;
  text?: string; // Text content
  audioUrl?: string; // URL for audio blob
  file?: { name: string; url: string }; // File download info
  type: 'text' | 'audio' | 'file' | 'system';
}

function App() {
  const [myPeerId, setMyPeerId] = useState<string | null>(null);
  const [myDisplayAddr, setMyDisplayAddr] = useState<string | null>(null);
  const [groupKey, setGroupKey] = useState<Buffer | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [targetPeerId, setTargetPeerId] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isScanning, setIsScanning] = useState(false); // QR Scanner state
  const [isRecording, setIsRecording] = useState(false); // Recording state
  const [recordingStatus, setRecordingStatus] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [filePassword, setFilePassword] = useState('');

  const peerRef = useRef<Peer | null>(null);
  const connectionsRef = useRef<Map<string, DataConnection>>(new Map());
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  // --- Group Key & Encryption --- (Adapted for web crypto)
  const updateGroupKey = useCallback(async () => {
    if (!myPeerId) return;
    const peerIds = sorted([myPeerId, ...connectionsRef.current.keys()]);
    try {
      const newKey = await sha256(JSON.stringify(peerIds));
      setGroupKey(newKey);
      console.log('[Debug] Group key updated');
    } catch (error) {
      console.error('[System] Error updating group key:', error);
      alert('Crypto Error: Failed to update group key.');
    }
  }, [myPeerId]);

  const xorCrypt = (dataBuffer: Buffer, keyBuffer: Buffer | null): Buffer => {
    if (!keyBuffer || keyBuffer.length === 0) {
      return dataBuffer; // No encryption if key is not set
    }
    const keyLen = keyBuffer.length;
    const result = Buffer.alloc(dataBuffer.length);
    for (let i = 0; i < dataBuffer.length; i++) {
      result[i] = dataBuffer[i] ^ keyBuffer[i % keyLen];
    }
    return result;
  };

  // --- PeerJS Initialization and Handlers ---
  useEffect(() => {
    const { display, peerId } = generateKAddr();
    setMyDisplayAddr(display);
    setIsLoading(true);

    const peerJsOptions = {
      host: '0.peerjs.com',
      port: 443,
      path: '/peerjs', // Ensure this matches index.html if using custom server
      secure: true,
      debug: 2,
    };

    console.log(`[System] Initializing PeerJS with ID: ${peerId}`);
    try {
      const newPeer = new Peer(peerId, peerJsOptions);
      peerRef.current = newPeer;

      newPeer.on('open', (id) => {
        console.log(`[System] PeerJS connection open. Your Peer ID: ${id}`);
        setMyPeerId(id);
        setIsConnected(true);
        setIsLoading(false);
        setMessages((prev) => [
          ...prev,
          { id: Date.now().toString(), type: 'system', text: `Connected! Your ID: ${id}`, from: 'System' },
        ]);
      });

      newPeer.on('connection', (conn) => {
        console.log(`[System] Incoming connection from ${conn.peer}`);
        setupConnectionHandlers(conn);
      });

      newPeer.on('disconnected', () => {
        console.log('[System] Disconnected from signaling server. Attempting to reconnect...');
        setIsConnected(false);
        // Don't set loading to false here, as we are trying to reconnect
        setMessages((prev) => [
          ...prev,
          { id: Date.now().toString(), type: 'system', text: 'Disconnected from server. Reconnecting...', from: 'System' },
        ]);
        // Attempt to reconnect after a delay (e.g., 5 seconds)
        setTimeout(() => {
            if (peerRef.current && !peerRef.current.destroyed && !peerRef.current.disconnected) {
                console.log('[System] Already reconnected or connection attempt in progress.');
                return;
            }
            if (peerRef.current && !peerRef.current.destroyed) {
                console.log('[System] Calling peer.reconnect()...');
                peerRef.current.reconnect();
            } else {
                console.log('[System] Peer was destroyed, cannot reconnect.');
                // Optionally trigger a full re-initialization here if desired
                setIsLoading(false); // Set loading false if reconnect is impossible
            }
        }, 5000); // 5 second delay before attempting reconnect
      });

      newPeer.on('close', () => {
        console.log('[System] Peer connection closed permanently.');
        setIsConnected(false);
        setIsLoading(false);
        peerRef.current = null;
        connectionsRef.current.clear();
        setMessages((prev) => [
          ...prev,
          { id: Date.now().toString(), type: 'system', text: 'Peer destroyed.', from: 'System' },
        ]);
      });

      newPeer.on('error', (err: any) => {
        console.error(`[System] PeerJS Error: ${err.type} - ${err.message}`);
        setIsConnected(false);
        setIsLoading(false);
        setMessages((prev) => [
          ...prev,
          { id: Date.now().toString(), type: 'system', text: `Error: ${err.message}`, from: 'System' },
        ]);
        if (err.type === 'unavailable-id') {
          alert(`Error: Peer ID ${peerId} is already taken. Please refresh the page.`);
        } else if (err.type === 'network' || err.type === 'server-error') {
          alert('Error: Network error connecting to signaling server.');
        } else {
          alert(`An unexpected PeerJS error occurred: ${err.type}`);
        }
      });
    } catch (initError) {
      console.error('[System] Failed to initialize PeerJS:', initError);
      setIsLoading(false);
      alert('Initialization Error: Could not initialize PeerJS. Check console and network.');
    }

    return () => {
      console.log('[System] Cleaning up PeerJS connection.');
      if (peerRef.current) {
        peerRef.current.destroy();
        peerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (myPeerId) {
      updateGroupKey();
    }
  }, [myPeerId, updateGroupKey]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // --- Connection Handlers (including file/audio) ---
  const setupConnectionHandlers = (conn: DataConnection) => {
    conn.on('open', () => {
      console.log(`[System] Data connection established with ${conn.peer}`);
      connectionsRef.current.set(conn.peer, conn);
      setMessages((prev) => [
        ...prev,
        { id: Date.now().toString(), type: 'system', text: `Connected to peer: ${conn.peer}`, from: 'System' },
      ]);
      updateGroupKey();
    });

    conn.on('data', async (data: unknown) => {
      try {
        // PeerJS might send ArrayBuffer for files/audio, string for text
        let payload: any;
        if (typeof data === 'string') {
          payload = JSON.parse(data);
        } else if (data instanceof ArrayBuffer) {
          // Attempt to parse as JSON first (might be file metadata)
          try {
            payload = JSON.parse(new TextDecoder().decode(data));
          } catch (e) {
            // If not JSON, assume it's raw file/audio data (needs context from sender)
            // This part is tricky without a clear protocol. Assuming sender sends metadata first.
            console.warn('[System] Received raw ArrayBuffer without clear type. Ignoring.');
            return;
          }
        } else if (data instanceof Blob) { // Handle direct Blob for audio
           payload = { type: 'audio', data: data, from: conn.metadata?.from || conn.peer }; // Assume sender set metadata
        } else {
            payload = data as any;
        }

        console.log('[System] Data received:', payload);

        if (payload && payload.type === 'text' && typeof payload.text === 'string') {
          const encryptedBuffer = Buffer.from(payload.text, 'latin1');
          const decryptedBuffer = xorCrypt(encryptedBuffer, groupKey);
          const receivedText = decryptedBuffer.toString('utf-8');
          setMessages((prev) => [
            ...prev,
            { id: Date.now().toString(), type: 'text', from: payload.from || conn.peer, text: receivedText },
          ]);
        } else if (payload && payload.type === 'file' && payload.filename && payload.data) {
          alert(`Receiving file from ${payload.from || conn.peer}: ${payload.filename}`);
          let keyBytes = groupKey;
          const encAll = Buffer.from(payload.data); // Data might be ArrayBuffer or similar
          let decAll: Buffer;

          if (payload.protected) {
            while (true) {
              const pwd = prompt(`Enter password for "${payload.filename}":`);
              if (pwd === null) {
                alert('File download cancelled.');
                return;
              }
              try {
                const pwdBuf = await sha256(pwd);
                keyBytes = pwdBuf;
                decAll = xorCrypt(encAll, keyBytes);
                const header = decAll.slice(0, 4).toString('utf-8');
                if (header === 'KQSP') {
                  makeDownload(decAll.slice(4), payload.filename, payload.from || conn.peer);
                  break;
                } else {
                  alert('Wrong password—please try again.');
                }
              } catch (pwdError) {
                console.error('Password processing error:', pwdError);
                alert('Error processing password. Please try again.');
              }
            }
          } else {
            decAll = xorCrypt(encAll, groupKey);
            makeDownload(decAll, payload.filename, payload.from || conn.peer);
          }
        } else if (payload && payload.type === 'audio' && payload.data instanceof Blob) {
          appendAudio(payload.data, payload.from || conn.peer);
        } else {
          console.log(`[System] Received unhandled message structure or type from ${conn.peer}:`, payload?.type);
          setMessages((prev) => [
            ...prev,
            { id: Date.now().toString(), type: 'system', text: `Received unhandled data from ${conn.peer}`, from: 'System' },
          ]);
        }
      } catch (e) {
        console.error(`[System] Error processing data from ${conn.peer}:`, e);
        console.error(`[System] Raw data received:`, data);
        setMessages((prev) => [
          ...prev,
          { id: Date.now().toString(), type: 'system', text: `Error processing data from ${conn.peer}`, from: 'System' },
        ]);
      }
    });

    conn.on('close', () => {
      console.log(`[System] Connection closed with ${conn.peer}`);
      connectionsRef.current.delete(conn.peer);
      setMessages((prev) => [
        ...prev,
        { id: Date.now().toString(), type: 'system', text: `Disconnected from peer: ${conn.peer}`, from: 'System' },
      ]);
      updateGroupKey();
    });

    conn.on('error', (err: any) => {
      console.error(`[System] Connection error with ${conn.peer}: ${err.message}`);
      connectionsRef.current.delete(conn.peer);
      setMessages((prev) => [
        ...prev,
        { id: Date.now().toString(), type: 'system', text: `Connection error with ${conn.peer}: ${err.message}`, from: 'System' },
      ]);
      updateGroupKey();
    });
  };

  // --- File/Audio Handling --- 
  const makeDownload = (decryptedData: Buffer, filename: string, from: string) => {
    const blob = new Blob([decryptedData], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    setMessages((prev) => [
      ...prev,
      { id: Date.now().toString(), type: 'file', from: from, file: { name: filename, url: url } },
    ]);
    // Note: URL.revokeObjectURL(url) should be called when the component unmounts or link is no longer needed
  };

  const appendAudio = (blob: Blob, from: string) => {
    const audioUrl = URL.createObjectURL(blob);
    setMessages((prev) => [
      ...prev,
      { id: Date.now().toString(), type: 'audio', from: from, audioUrl: audioUrl },
    ]);
    // Note: URL.revokeObjectURL(audioUrl) should be called later
  };

  // --- Message Sending --- 
  const sendTextMessage = () => {
    if (!inputValue.trim() || !groupKey || !myDisplayAddr || connectionsRef.current.size === 0) {
      alert('Cannot send message. Check connection, group key, and input.');
      return;
    }

    const text = inputValue.trim();
    const textBuffer = Buffer.from(text, 'utf-8');
    const encryptedBuffer = xorCrypt(textBuffer, groupKey);

    const payload = {
      type: 'text',
      from: myDisplayAddr,
      text: encryptedBuffer.toString('latin1'),
    };
    const messageStr = JSON.stringify(payload);
    broadcast(messageStr, 'text', text);
    setInputValue('');
  };

  // --- Voice Recording --- 
  const handleRecordClick = async () => {
    if (isRecording) {
      // Stop recording
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
      setIsRecording(false);
      setRecordingStatus('');
    } else {
      // Start recording
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        alert('getUserMedia not supported on your browser!');
        setRecordingStatus('Browser not supported.');
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorderRef.current = new MediaRecorder(stream);
        audioChunksRef.current = []; // Clear previous chunks

        mediaRecorderRef.current.ondataavailable = (event) => {
          if (event.data.size > 0) {
            audioChunksRef.current.push(event.data);
          }
        };

        mediaRecorderRef.current.onstop = () => {
          const audioBlob = new Blob(audioChunksRef.current, {
            type: mediaRecorderRef.current?.mimeType || 'audio/webm',
          });
          audioChunksRef.current = [];
          if (audioBlob.size > 0) {
            sendAudio(audioBlob);
          } else {
            console.log('No audio data recorded.');
          }
          stream.getTracks().forEach((track) => track.stop()); // Stop mic access
        };

        mediaRecorderRef.current.onerror = (event: any) => {
          console.error(`MediaRecorder error: ${event.error}`);
          alert(`Recording error: ${event.error?.name || 'Unknown error'}`);
          setIsRecording(false);
          setRecordingStatus('Recording error.');
          stream.getTracks().forEach((track) => track.stop());
        };

        mediaRecorderRef.current.start();
        setIsRecording(true);
        setRecordingStatus('Recording...');
      } catch (err) {
        console.error('Error accessing microphone:', err);
        alert('Could not access microphone. Please ensure permission is granted.');
        setRecordingStatus('Mic access error.');
      }
    }
  };

  const sendAudio = (blob: Blob) => {
    if (!myDisplayAddr || connectionsRef.current.size === 0) {
      alert('Cannot send audio. Check connection and display address.');
      return;
    }
    // PeerJS can send Blob directly. Add metadata for sender info.
    const payload = { 
        type: 'audio', 
        from: myDisplayAddr, 
        mimeType: blob.type, 
        data: blob 
    };
    broadcast(payload, 'audio');
    setRecordingStatus('Voice message sent.');
    setTimeout(() => setRecordingStatus(''), 2000);
  };

  // --- File Sending --- 
  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files && event.target.files[0]) {
      setSelectedFile(event.target.files[0]);
    } else {
      setSelectedFile(null);
    }
  };

  const sendFile = async () => {
    if (!selectedFile || !groupKey || !myDisplayAddr || connectionsRef.current.size === 0) {
      alert('Cannot send file. Select a file and ensure connection/key.');
      return;
    }

    const reader = new FileReader();
    reader.onload = async (event) => {
      if (!event.target?.result) return;
      let fileData = Buffer.from(event.target.result as ArrayBuffer);
      let keyBytes = groupKey;
      let protectedFlag = false;

      if (filePassword) {
        protectedFlag = true;
        try {
          keyBytes = await sha256(filePassword);
          const header = Buffer.from('KQSP', 'utf-8');
          fileData = Buffer.concat([header, fileData]);
        } catch (pwdError) {
          console.error('Password hashing error:', pwdError);
          alert('Error processing file password.');
          return;
        }
      }

      const encryptedData = xorCrypt(fileData, keyBytes);

      const payload = {
        type: 'file',
        from: myDisplayAddr,
        filename: selectedFile.name,
        protected: protectedFlag,
        data: encryptedData.buffer, // Send ArrayBuffer
      };

      broadcast(payload, 'file');
      alert(`Encrypted file sent: ${selectedFile.name}`);
      // Reset file input if needed
      setSelectedFile(null);
      setFilePassword('');
      // Consider clearing the file input element itself
      const fileInput = document.getElementById('file-input') as HTMLInputElement;
      if (fileInput) fileInput.value = '';

    };
    reader.onerror = (error) => {
      console.error('File reading error:', error);
      alert('Error reading file.');
    };
    reader.readAsArrayBuffer(selectedFile);
  };

  // --- Broadcasting --- 
  const broadcast = (payload: any, type: 'text' | 'audio' | 'file', originalText?: string) => {
    let sentToAny = false;
    connectionsRef.current.forEach((conn, peerId) => {
      if (conn && conn.open) {
        try {
          // Pass sender info via metadata for audio/file if needed
          const options = (type === 'audio' || type === 'file') ? { metadata: { from: myDisplayAddr } } : undefined;
          conn.send(payload, options);
          sentToAny = true;
        } catch (e: any) {
          console.error(`[System] Failed to send to ${peerId}: ${e.message}`);
          alert(`Failed to send message to ${peerId}.`);
        }
      } else {
        console.log(`[System] Connection to ${peerId} is not open or invalid.`);
      }
    });

    if (sentToAny) {
      if (type === 'text' && originalText) {
        setMessages((prev) => [
          ...prev,
          { id: Date.now().toString(), type: 'text', from: 'You', text: originalText },
        ]);
      } else if (type === 'audio' && payload.data instanceof Blob) {
         appendAudio(payload.data, 'You'); // Show own audio
      } else if (type === 'file') {
        // Optionally show a 'file sent' message
         setMessages((prev) => [
          ...prev,
          { id: Date.now().toString(), type: 'system', from: 'System', text: `You sent file: ${payload.filename}` },
        ]);
      }
    } else {
      alert(`Could not send ${type} to any connected peers.`);
    }
  };

  // --- Connection Handling --- 
  const handleConnect = () => {
    const peerToConnect = targetPeerId.trim();
    if (!peerToConnect || !peerRef.current || !isConnected) {
      alert('Enter Peer ID and ensure connection is active.');
      return;
    }
    if (connectionsRef.current.has(peerToConnect)) {
      alert('Already connected to this peer.');
      return;
    }

    console.log(`[System] Attempting to connect to ${peerToConnect}...`);
    setMessages((prev) => [
      ...prev,
      { id: Date.now().toString(), type: 'system', text: `Connecting to ${peerToConnect}...`, from: 'System' },
    ]);
    try {
      const conn = peerRef.current.connect(peerToConnect, {
        reliable: true,
        metadata: { from: myDisplayAddr } // Send our display addr on connect
      });
      setupConnectionHandlers(conn);
    } catch (connectError: any) {
      console.error(`[System] Failed to initiate connection to ${peerToConnect}:`, connectError);
      alert(`Could not initiate connection: ${connectError.message}`);
      setMessages((prev) =>
        prev.filter((msg) => !(msg.type === 'system' && msg.text?.startsWith(`Connecting to ${peerToConnect}`)))
      );
    }
  };

  // --- QR Scanner Handling ---
  const handleScanResult = (result: any, error: any) => {
    if (result) {
      const scannedText = result?.getText();
      console.log('QR Scan Result:', scannedText);
      if (scannedText && scannedText.startsWith('K(') && scannedText.endsWith(')')) {
          const kAddr = scannedText;
          // Extract PeerJS ID from K(addr) - assumes format K(a.b.c.d) -> peerjs-id-a-b-c-d-suffix
          // This needs to match the actual ID generation logic more robustly.
          // For now, just put the K(addr) in the input for manual connection.
          // A better approach would be to scan the actual PeerJS ID.
          setTargetPeerId(kAddr); // Or extract the real ID if QR contains it
          alert(`Scanned: ${kAddr}. Enter the actual PeerJS ID if different.`);
          setIsScanning(false); // Close scanner on successful scan
      } else if (scannedText) {
          // If it's not K(addr), maybe it's the direct PeerJS ID?
          setTargetPeerId(scannedText);
          alert(`Scanned Peer ID: ${scannedText}. Press Connect.`);
          setIsScanning(false);
      }
    }

    if (error) {
      // console.info('QR Scan Error:', error); // Too noisy
    }
  };

  // --- Render Logic --- 
  if (isLoading) {
    return (
      <div className="loading-container">
        <p>Initializing Peer Connection...</p>
      </div>
    );
  }

  return (
    <div className="app-container">
      <header className="app-header">
        <h1>KQSP Web</h1>
        <p className="status-text">
          {myDisplayAddr || 'Initializing...'} ({isConnected ? 'Online' : 'Offline'})
        </p>
        {myPeerId && (
          <div className="qr-code-container">
            <p className="peer-id-text">Your ID: {myPeerId}</p>
            <QRCode value={myPeerId} size={128} />
            {/* Display K(addr) as well if desired */} 
            {/* <QRCode value={myDisplayAddr || ''} size={128} /> */} 
          </div>
        )}
      </header>

      <div className="connection-area">
        <input
          type="text"
          className="peer-id-input"
          placeholder="Enter Peer ID or K(addr) to Connect"
          value={targetPeerId}
          onChange={(e) => setTargetPeerId(e.target.value)}
          disabled={!isConnected}
        />
        <button onClick={handleConnect} disabled={!isConnected || !targetPeerId.trim()}>
          Connect
        </button>
        <button onClick={() => setIsScanning(!isScanning)} disabled={!isConnected}>
          {isScanning ? 'Stop Scan' : 'Scan QR'}
        </button>
      </div>

      {isScanning && (
        <div className="qr-scanner-container">
          <QrReader
            onResult={handleScanResult}
            constraints={{ facingMode: 'environment' }}
            containerStyle={{ width: '100%' }}
          />
          <p>Point camera at QR code</p>
        </div>
      )}

      <div className="messages-container">
        {messages.map((msg) => (
          <div key={msg.id} className={`message-bubble ${msg.from === 'You' ? 'own-message' : 'other-message'} ${msg.type === 'system' ? 'system-message' : ''}`}>
            {msg.type !== 'system' && <span className="message-sender">{msg.from}: </span>}
            {msg.type === 'text' && <span className="message-text">{msg.text}</span>}
            {msg.type === 'audio' && msg.audioUrl && (
              <audio controls src={msg.audioUrl}></audio>
            )}
            {msg.type === 'file' && msg.file && (
              <a href={msg.file.url} download={msg.file.name} className="file-link">
                Download {msg.file.name}
              </a>
            )}
             {msg.type === 'system' && <span className="message-text">{msg.text}</span>} {/* Ensure system messages also display text */} 
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      <div className="input-area">
        <textarea
          className="message-input"
          placeholder="Type your message..."
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          disabled={!isConnected || connectionsRef.current.size === 0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              sendTextMessage();
            }
          }}
        />
        <button onClick={sendTextMessage} disabled={!isConnected || connectionsRef.current.size === 0 || !inputValue.trim()}>
          Send
        </button>
        <button onClick={handleRecordClick} disabled={!isConnected || connectionsRef.current.size === 0}>
          {isRecording ? '🛑 Stop' : '🎤 Record'}
        </button>
        <span className="record-status">{recordingStatus}</span>
      </div>

      <div className="file-area">
        <input type="file" id="file-input" onChange={handleFileChange} disabled={!isConnected || connectionsRef.current.size === 0} />
        <input
          type="password"
          className="password-input"
          placeholder="File password (optional)"
          value={filePassword}
          onChange={(e) => setFilePassword(e.target.value)}
          disabled={!isConnected || connectionsRef.current.size === 0 || !selectedFile}
        />
        <button onClick={sendFile} disabled={!isConnected || connectionsRef.current.size === 0 || !selectedFile}>
          Send File
        </button>
      </div>
    </div>
  );
}

export default App;
