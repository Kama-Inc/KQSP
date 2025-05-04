/**
 * KQSP Mobile App - React Native
 * @format
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { PropsWithChildren } from 'react';
import {
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  useColorScheme,
  View,
  Button,
  PermissionsAndroid, // Keep for potential future use (e.g., microphone)
  Platform,
  Alert,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { Peer, DataConnection } from 'peerjs'; // Import types
import { Buffer } from 'buffer'; // For XOR encryption
import crypto from 'react-native-crypto'; // For SHA256 hashing
// Ensure crypto polyfills are set up if needed, often requires react-native-get-random-values
import 'react-native-get-random-values';

// Polyfill Buffer if needed
global.Buffer = Buffer;

// --- K(addr) Generation --- (Simplified version)
function generateKAddr() {
  const parts = Array.from({ length: 4 }, () => Math.floor(Math.random() * 256));
  const display = parts.join('.');
  // Use a more robust ID generation for production
  const peerId = `kqsp-mobile-${parts.join('-')}-${Date.now().toString(36).slice(-4)}`;
  return {
    display: `K(${display})`,
    peerId,
  };
}

// Helper for sorting keys
function sorted(arr: string[]): string[] {
  return [...arr].sort();
}

interface Message {
  id: string;
  from: string;
  text: string;
  type: 'text' | 'audio' | 'system'; // Extend as needed
}

function App(): React.JSX.Element {
  const isDarkMode = useColorScheme() === 'dark';
  const [myPeerId, setMyPeerId] = useState<string | null>(null);
  const [myDisplayAddr, setMyDisplayAddr] = useState<string | null>(null);
  const [groupKey, setGroupKey] = useState<Buffer | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [targetPeerId, setTargetPeerId] = useState('');
  const [isConnected, setIsConnected] = useState(false); // Track signaling server connection
  const [isLoading, setIsLoading] = useState(true); // Loading state for PeerJS init

  const peerRef = useRef<Peer | null>(null);
  const connectionsRef = useRef<Map<string, DataConnection>>(new Map());
  const scrollViewRef = useRef<ScrollView>(null);

  // --- Group Key & Encryption --- (Adapted for state)
  const updateGroupKey = useCallback(() => {
    if (!myPeerId) return;
    const peerIds = sorted([myPeerId, ...connectionsRef.current.keys()]);
    try {
      const hasher = crypto.createHash('sha256');
      hasher.update(JSON.stringify(peerIds));
      const newKey = hasher.digest();
      setGroupKey(newKey);
      console.log('[Debug] Group key updated');
    } catch (error) {
        console.error("[System] Error updating group key:", error);
        Alert.alert("Crypto Error", "Failed to update group key.");
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

    // IMPORTANT: Configure this to match your web/CLI version's signaling server!
    const peerJsOptions = {
      host: '0.peerjs.com', // Default public PeerJS server
      port: 443,
      path: '/',
      secure: true,
      debug: 2, // 0: Errors, 1: Warnings, 2: Info, 3: Verbose
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
          setMessages(prev => [...prev, { id: Date.now().toString(), type: 'system', text: `Connected! Your ID: ${id}`, from: 'System' }]);
        });

        newPeer.on('connection', (conn) => {
          console.log(`[System] Incoming connection from ${conn.peer}`);
          setupConnectionHandlers(conn);
        });

        newPeer.on('disconnected', () => {
          console.log('[System] Disconnected from signaling server. Attempting to reconnect...');
          setIsConnected(false);
          setIsLoading(false); // No longer loading if disconnected
          setMessages(prev => [...prev, { id: Date.now().toString(), type: 'system', text: 'Disconnected from server...', from: 'System' }]);
        });

        newPeer.on('close', () => {
          console.log('[System] Peer connection closed permanently.');
          setIsConnected(false);
          setIsLoading(false);
          peerRef.current = null; // Clear ref
          setMessages(prev => [...prev, { id: Date.now().toString(), type: 'system', text: 'Peer destroyed.', from: 'System' }]);
        });

        newPeer.on('error', (err: any) => { // Use 'any' for err type as PeerJS types might be incomplete
          console.error(`[System] PeerJS Error: ${err.type} - ${err.message}`);
          setIsConnected(false);
          setIsLoading(false);
          setMessages(prev => [...prev, { id: Date.now().toString(), type: 'system', text: `Error: ${err.message}`, from: 'System' }]);
          if (err.type === 'unavailable-id') {
            Alert.alert('Error', `Peer ID ${peerId} is already taken. Please restart the app.`);
          } else if (err.type === 'network') {
             Alert.alert('Error', 'Network error connecting to signaling server.');
          } else if (err.type === 'server-error') {
             Alert.alert('Error', 'Unable to reach signaling server.');
          } else {
             Alert.alert('Peer Error', `An unexpected PeerJS error occurred: ${err.type}`);
          }
        });
    } catch (initError) {
        console.error("[System] Failed to initialize PeerJS:", initError);
        setIsLoading(false);
        Alert.alert("Initialization Error", "Could not initialize PeerJS. Please check configuration and network.");
    }

    // Cleanup on unmount
    return () => {
      console.log('[System] Cleaning up PeerJS connection.');
      if (peerRef.current) {
        peerRef.current.destroy();
        peerRef.current = null;
      }
    };
  }, []); // Run only once on mount

  // Update group key when myPeerId changes or connections change
  useEffect(() => {
    if (myPeerId) { // Only update if we have an ID
        updateGroupKey();
    }
  }, [myPeerId, updateGroupKey]);

  const setupConnectionHandlers = (conn: DataConnection) => {
    conn.on('open', () => {
      console.log(`[System] Data connection established with ${conn.peer}`);
      connectionsRef.current.set(conn.peer, conn);
      setMessages(prev => [...prev, { id: Date.now().toString(), type: 'system', text: `Connected to peer: ${conn.peer}`, from: 'System' }]);
      updateGroupKey(); // Update key now that connection is established
    });

    conn.on('data', (data: unknown) => { // Use unknown type for incoming data
      try {
        // PeerJS might automatically parse JSON, but handle both cases
        const payload = typeof data === 'string' ? JSON.parse(data) : data as any;
        console.log('[System] Data received:', payload);

        if (payload && payload.type === 'text' && typeof payload.text === 'string') {
          const encryptedBuffer = Buffer.from(payload.text, 'latin1');
          const decryptedBuffer = xorCrypt(encryptedBuffer, groupKey);
          const receivedText = decryptedBuffer.toString('utf-8');
          setMessages(prev => [...prev, { id: Date.now().toString(), type: 'text', from: payload.from || conn.peer, text: receivedText }]);
        } else {
          console.log(`[System] Received unhandled message structure or type from ${conn.peer}`);
          setMessages(prev => [...prev, { id: Date.now().toString(), type: 'system', text: `Received unhandled data from ${conn.peer}`, from: 'System' }]);
        }
      } catch (e) {
        console.error(`[System] Error processing data from ${conn.peer}:`, e);
        console.error(`[System] Raw data received:`, data);
        setMessages(prev => [...prev, { id: Date.now().toString(), type: 'system', text: `Error processing data from ${conn.peer}`, from: 'System' }]);
      }
    });

    conn.on('close', () => {
      console.log(`[System] Connection closed with ${conn.peer}`);
      connectionsRef.current.delete(conn.peer);
      setMessages(prev => [...prev, { id: Date.now().toString(), type: 'system', text: `Disconnected from peer: ${conn.peer}`, from: 'System' }]);
      updateGroupKey();
    });

    conn.on('error', (err: any) => {
      console.error(`[System] Connection error with ${conn.peer}: ${err.message}`);
      connectionsRef.current.delete(conn.peer);
      setMessages(prev => [...prev, { id: Date.now().toString(), type: 'system', text: `Connection error with ${conn.peer}: ${err.message}`, from: 'System' }]);
      updateGroupKey();
    });
  };

  // --- Message Sending ---
  const sendTextMessage = () => {
    if (!inputValue.trim()) return;
    if (connectionsRef.current.size === 0) {
      Alert.alert('No Connection', 'No peers connected to send message.');
      return;
    }
    if (!groupKey) {
      Alert.alert('Error', 'Group key not yet established. Cannot send message.');
      return;
    }
    if (!myDisplayAddr) {
      Alert.alert('Error', 'Display address not set. Cannot send message.');
      return;
    }

    const text = inputValue.trim();
    const textBuffer = Buffer.from(text, 'utf-8');
    const encryptedBuffer = xorCrypt(textBuffer, groupKey);

    const payload = {
      type: 'text',
      from: myDisplayAddr, // Send our display address
      text: encryptedBuffer.toString('latin1'), // Encode buffer as latin1 string
    };

    const messageStr = JSON.stringify(payload);
    let sentToAny = false;

    connectionsRef.current.forEach((conn, peerId) => {
      if (conn && conn.open) {
        try {
          conn.send(messageStr);
          sentToAny = true;
        } catch (e: any) {
          console.error(`[System] Failed to send to ${peerId}: ${e.message}`);
          Alert.alert('Send Error', `Failed to send message to ${peerId}.`);
        }
      } else {
        console.log(`[System] Connection to ${peerId} is not open or invalid.`);
      }
    });

    if (sentToAny) {
      setMessages(prev => [...prev, { id: Date.now().toString(), type: 'text', from: 'You', text: text }]);
      setInputValue(''); // Clear input after sending
    } else {
       Alert.alert('Send Error', 'Could not send message to any connected peers.');
    }
  };

  // --- Connection Handling ---
  const handleConnect = () => {
    const peerToConnect = targetPeerId.trim();
    if (!peerToConnect) {
      Alert.alert('Invalid ID', 'Please enter a Peer ID to connect to.');
      return;
    }
    if (!peerRef.current) {
      Alert.alert('Error', 'Peer connection not initialized.');
      return;
    }
    if (connectionsRef.current.has(peerToConnect)) {
      Alert.alert('Already Connected', 'Already connected to this peer.');
      return;
    }

    console.log(`[System] Attempting to connect to ${peerToConnect}...`);
    setMessages(prev => [...prev, { id: Date.now().toString(), type: 'system', text: `Connecting to ${peerToConnect}...`, from: 'System' }]);
    try {
        const conn = peerRef.current.connect(peerToConnect, {
          reliable: true,
        });
        setupConnectionHandlers(conn);
    } catch (connectError: any) {
        console.error(`[System] Failed to initiate connection to ${peerToConnect}:`, connectError);
        Alert.alert("Connection Error", `Could not initiate connection: ${connectError.message}`);
        setMessages(prev => prev.filter(msg => !(msg.type === 'system' && msg.text.startsWith(`Connecting to ${peerToConnect}`)))); // Remove connecting message
    }
  };

  const backgroundStyle = {
    backgroundColor: isDarkMode ? '#222' : '#F5F5F5', // Slightly adjusted colors
    flex: 1,
  };
  const textStyle = {
    color: isDarkMode ? '#E0E0E0' : '#111',
  };

  if (isLoading) {
    return (
      <SafeAreaView style={[backgroundStyle, styles.centerContainer]}>
        <ActivityIndicator size="large" color={isDarkMode ? '#FFF' : '#000'} />
        <Text style={[textStyle, { marginTop: 10 }]}>Initializing Peer Connection...</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={backgroundStyle}>
      <StatusBar barStyle={isDarkMode ? 'light-content' : 'dark-content'} backgroundColor={backgroundStyle.backgroundColor} />
      <View style={styles.header}>
        <Text style={[styles.headerTitle, textStyle]}>KQSP Mobile</Text>
        <Text style={[styles.statusText, textStyle]}>
          {myDisplayAddr || 'Initializing...'} ({isConnected ? 'Online' : 'Offline'})
        </Text>
        {myPeerId && <Text style={[styles.peerIdText, textStyle]}>ID: {myPeerId}</Text>}
      </View>

      <View style={styles.connectionArea}>
        <TextInput
          style={[styles.input, styles.peerIdInput, isDarkMode ? styles.inputDark : styles.inputLight]}
          placeholder="Enter Peer ID to Connect"
          placeholderTextColor={isDarkMode ? '#888' : '#999'}
          value={targetPeerId}
          onChangeText={setTargetPeerId}
          autoCapitalize="none"
          editable={isConnected} // Only allow editing if connected to signaling server
        />
        <Button title="Connect" onPress={handleConnect} disabled={!isConnected || !targetPeerId.trim()} />
      </View>

      <ScrollView
        style={styles.messagesContainer}
        ref={scrollViewRef}
        onContentSizeChange={() => scrollViewRef.current?.scrollToEnd({ animated: true })}>
        {messages.map((msg) => (
          <View key={msg.id} style={styles.messageBubble(msg.from === 'You', isDarkMode)}>
            {msg.type === 'system' ? (
              <Text style={[styles.messageText, styles.systemMessage, textStyle]}>{msg.text}</Text>
            ) : (
              <>
                <Text style={[styles.messageSender, textStyle, { color: isDarkMode ? '#A0A0A0' : '#555' }]}>{msg.from}</Text>
                <Text style={[styles.messageText, textStyle]}>{msg.text}</Text>
              </>
            )}
          </View>
        ))}
      </ScrollView>

      <View style={styles.inputArea}>
        <TextInput
          style={[styles.input, styles.messageInput, isDarkMode ? styles.inputDark : styles.inputLight]}
          placeholder="Type your message..."
          placeholderTextColor={isDarkMode ? '#888' : '#999'}
          value={inputValue}
          onChangeText={setInputValue}
          multiline
          editable={isConnected && connectionsRef.current.size > 0} // Only allow input if connected to peers
        />
        {/* Add Microphone button here later */}
        <Button title="Send" onPress={sendTextMessage} disabled={!isConnected || connectionsRef.current.size === 0 || !inputValue.trim()} />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  centerContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
  },
  header: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#444',
    alignItems: 'center',
    backgroundColor: '#333', // Header background
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#FFF', // Header text color
  },
  statusText: {
    fontSize: 14,
    marginTop: 4,
    color: '#CCC', // Lighter status text
  },
  peerIdText: {
    fontSize: 12,
    color: '#AAA',
    marginTop: 2,
  },
  connectionArea: {
    flexDirection: 'row',
    padding: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#444',
    alignItems: 'center',
    backgroundColor: '#303030', // Slightly different background
  },
  peerIdInput: {
    flex: 1,
    marginRight: 10,
    height: 40,
  },
  messagesContainer: {
    flex: 1,
    padding: 10,
  },
  messageBubble: (isOwnMessage: boolean, isDarkMode: boolean) => ({
    maxWidth: '80%',
    padding: 10,
    borderRadius: 15,
    marginBottom: 10,
    alignSelf: isOwnMessage ? 'flex-end' : 'flex-start',
    backgroundColor: isOwnMessage
        ? (isDarkMode ? '#056524' : '#DCF8C6') // Darker green for dark mode
        : (isDarkMode ? '#373737' : '#FFF'),
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.2,
    shadowRadius: 1.41,
    elevation: 2,
  }),
  messageSender: {
    fontWeight: 'bold',
    marginBottom: 4,
    fontSize: 12,
  },
  messageText: {
    fontSize: 16,
  },
  systemMessage: {
    fontStyle: 'italic',
    color: '#999',
    textAlign: 'center',
    alignSelf: 'center',
    marginBottom: 10,
    paddingHorizontal: 10,
  },
  inputArea: {
    flexDirection: 'row',
    padding: 10,
    borderTopWidth: 1,
    borderTopColor: '#444',
    alignItems: 'center',
    backgroundColor: '#303030',
  },
  input: {
    borderWidth: 1,
    borderColor: '#555',
    borderRadius: 20, // More rounded input
    paddingHorizontal: 15,
    paddingVertical: Platform.OS === 'ios' ? 10 : 8, // Adjust padding per platform
    fontSize: 16,
  },
  inputLight: {
      backgroundColor: '#FFF',
      color: '#111',
      borderColor: '#CCC',
  },
  inputDark: {
      backgroundColor: '#404040',
      color: '#E0E0E0',
      borderColor: '#666',
  },
  messageInput: {
    flex: 1,
    marginRight: 10,
    maxHeight: 100, // Limit input height
  },
});

export default App;
