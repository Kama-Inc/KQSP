/**
 * KQSP Mobile App - React Native
 */

import React, {
    useState,
    useEffect,
    useRef,
    useCallback
} from 'react';
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
    PermissionsAndroid,
    Platform,
    Alert,
    TouchableOpacity,
} from 'react-native';
import {
    Peer
} from 'peerjs'; // Assuming peerjs library is installed
import {
    Buffer
} from 'buffer'; // For XOR encryption
import crypto from 'react-native-crypto'; // For SHA256 hashing
// Note: You might need to install react-native-get-random-values if crypto needs it
// import 'react-native-get-random-values';

// Polyfill Buffer if needed (often required in React Native)
global.Buffer = Buffer;

// --- K(addr) Generation --- (Simplified version)
function generateKAddr() {
    const parts = Array.from({
        length: 4
    }, () => Math.floor(Math.random() * 256));
    const display = parts.join('.');
    // Use a more robust ID generation for production
    const peerId = `kqsp-mobile-${parts.join('-')}-${Date.now().toString(36).slice(-4)}`;
    return {
        display: `K(${display})`,
        peerId,
    };
}

// Helper for sorting keys
function sorted(arr) {
    return [...arr].sort();
}

function App() {
    const isDarkMode = useColorScheme() === 'dark';
    const [myPeerId, setMyPeerId] = useState(null);
    const [myDisplayAddr, setMyDisplayAddr] = useState(null);
    const [groupKey, setGroupKey] = useState(null);
    const [messages, setMessages] = useState([]); // { id: string, from: string, text: string, type: 'text' | 'audio' | 'system' }
    const [inputValue, setInputValue] = useState('');
    const [targetPeerId, setTargetPeerId] = useState('');
    const [isConnected, setIsConnected] = useState(false); // Track signaling server connection

    const peerRef = useRef(null);
    const connectionsRef = useRef(new Map());
    const scrollViewRef = useRef();

    // --- Group Key & Encryption --- (Adapted for state)
    const updateGroupKey = useCallback(() => {
        if (!myPeerId) return;
        const peerIds = sorted([myPeerId, ...connectionsRef.current.keys()]);
        const hasher = crypto.createHash('sha256');
        hasher.update(JSON.stringify(peerIds));
        const newKey = hasher.digest();
        setGroupKey(newKey);
        console.log('[Debug] Group key updated');
    }, [myPeerId]);

    const xorCrypt = (dataBuffer, keyBuffer) => {
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
        const {
            display,
            peerId
        } = generateKAddr();
        setMyDisplayAddr(display);

        // IMPORTANT: Configure this to match your web/CLI version's signaling server!
        const peerJsOptions = {
            host: '0.peerjs.com', // Default public PeerJS server
            port: 443,
            path: '/',
            secure: true,
            debug: 2, // 0: Errors, 1: Warnings, 2: Info, 3: Verbose
            // wrtc: wrtc // Not needed in React Native (uses native WebRTC)
        };

        console.log(`[System] Initializing PeerJS with ID: ${peerId}`);
        const newPeer = new Peer(peerId, peerJsOptions);
        peerRef.current = newPeer;

        newPeer.on('open', (id) => {
            console.log(`[System] PeerJS connection open. Your Peer ID: ${id}`);
            setMyPeerId(id);
            setIsConnected(true);
            setMessages(prev => [...prev, {
                id: Date.now().toString(),
                type: 'system',
                text: `Connected! Your ID: ${id}`
            }]);
            // Initial group key update relies on myPeerId state update, handled by useEffect dependency
        });

        newPeer.on('connection', (conn) => {
            console.log(`[System] Incoming connection from ${conn.peer}`);
            setupConnectionHandlers(conn);
        });

        newPeer.on('disconnected', () => {
            console.log('[System] Disconnected from signaling server. Attempting to reconnect...');
            setIsConnected(false);
            setMessages(prev => [...prev, {
                id: Date.now().toString(),
                type: 'system',
                text: 'Disconnected from server...'
            }]);
            // PeerJS attempts reconnection automatically
        });

        newPeer.on('close', () => {
            console.log('[System] Peer connection closed permanently.');
            setIsConnected(false);
            peerRef.current = null; // Clear ref
            setMessages(prev => [...prev, {
                id: Date.now().toString(),
                type: 'system',
                text: 'Peer destroyed.'
            }]);
        });

        newPeer.on('error', (err) => {
            console.error(`[System] PeerJS Error: ${err.type} - ${err.message}`);
            setIsConnected(false);
            setMessages(prev => [...prev, {
                id: Date.now().toString(),
                type: 'system',
                text: `Error: ${err.message}`
            }]);
            if (err.type === 'unavailable-id') {
                Alert.alert('Error', `Peer ID ${peerId} is already taken. Please restart the app.`);
            } else if (err.type === 'network') {
                Alert.alert('Error', 'Network error connecting to signaling server.');
            } else if (err.type === 'server-error') {
                Alert.alert('Error', 'Unable to reach signaling server.');
            }
            // Consider attempting to reconnect or exit based on error type
        });

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
        updateGroupKey();
    }, [myPeerId, updateGroupKey]); // updateGroupKey dependency ensures it runs when connections change via setupConnectionHandlers

    const setupConnectionHandlers = (conn) => {
        conn.on('open', () => {
            console.log(`[System] Data connection established with ${conn.peer}`);
            connectionsRef.current.set(conn.peer, conn);
            setMessages(prev => [...prev, {
                id: Date.now().toString(),
                type: 'system',
                text: `Connected to peer: ${conn.peer}`
            }]);
            updateGroupKey(); // Update key now that connection is established
        });

        conn.on('data', (data) => {
            try {
                const payload = typeof data === 'string' ? JSON.parse(data) : data;
                console.log('[System] Data received:', payload);

                if (payload.type === 'text') {
                    const encryptedBuffer = Buffer.from(payload.text, 'latin1');
                    const decryptedBuffer = xorCrypt(encryptedBuffer, groupKey);
                    const receivedText = decryptedBuffer.toString('utf-8');
                    setMessages(prev => [...prev, {
                        id: Date.now().toString(),
                        type: 'text',
                        from: payload.from || conn.peer,
                        text: receivedText
                    }]);
                } else {
                    console.log(`[System] Received unhandled message type '${payload.type}' from ${conn.peer}`);
                    setMessages(prev => [...prev, {
                        id: Date.now().toString(),
                        type: 'system',
                        text: `Received unhandled data from ${conn.peer}`
                    }]);
                }
            } catch (e) {
                console.error(`[System] Error processing data from ${conn.peer}:`, e);
                console.error(`[System] Raw data received:`, data);
                setMessages(prev => [...prev, {
                    id: Date.now().toString(),
                    type: 'system',
                    text: `Error processing data from ${conn.peer}`
                }]);
            }
        });

        conn.on('close', () => {
            console.log(`[System] Connection closed with ${conn.peer}`);
            connectionsRef.current.delete(conn.peer);
            setMessages(prev => [...prev, {
                id: Date.now().toString(),
                type: 'system',
                text: `Disconnected from peer: ${conn.peer}`
            }]);
            updateGroupKey();
        });

        conn.on('error', (err) => {
            console.error(`[System] Connection error with ${conn.peer}: ${err.message}`);
            connectionsRef.current.delete(conn.peer);
            setMessages(prev => [...prev, {
                id: Date.now().toString(),
                type: 'system',
                text: `Connection error with ${conn.peer}`
            }]);
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
                } catch (e) {
                    console.error(`[System] Failed to send to ${peerId}: ${e.message}`);
                    Alert.alert('Send Error', `Failed to send message to ${peerId}.`);
                }
            } else {
                console.log(`[System] Connection to ${peerId} is not open or invalid.`);
            }
        });

        if (sentToAny) {
            setMessages(prev => [...prev, {
                id: Date.now().toString(),
                type: 'text',
                from: 'You',
                text: text
            }]);
            setInputValue(''); // Clear input after sending
        } else {
            Alert.alert('Send Error', 'Could not send message to any connected peers.');
        }
    };

    // --- Connection Handling ---
    const handleConnect = () => {
        if (!targetPeerId.trim()) {
            Alert.alert('Invalid ID', 'Please enter a Peer ID to connect to.');
            return;
        }
        if (!peerRef.current) {
            Alert.alert('Error', 'Peer connection not initialized.');
            return;
        }
        if (connectionsRef.current.has(targetPeerId.trim())) {
            Alert.alert('Already Connected', 'Already connected to this peer.');
            return;
        }

        console.log(`[System] Attempting to connect to ${targetPeerId.trim()}...`);
        setMessages(prev => [...prev, {
            id: Date.now().toString(),
            type: 'system',
            text: `Connecting to ${targetPeerId.trim()}...`
        }]);
        const conn = peerRef.current.connect(targetPeerId.trim(), {
            reliable: true,
        });
        setupConnectionHandlers(conn);
    };

    const backgroundStyle = {
        backgroundColor: isDarkMode ? '#333' : '#F3F3F3',
        flex: 1,
    };
    const textStyle = {
        color: isDarkMode ? '#FFF' : '#000',
    };

    return ( <
        SafeAreaView style = {
            backgroundStyle
        } >
        <
        StatusBar barStyle = {
            isDarkMode ? 'light-content' : 'dark-content'
        }
        /> <
        View style = {
            styles.header
        } >
        <
        Text style = {
            [styles.headerTitle, textStyle]
        } > KQSP Mobile < /Text> <
        Text style = {
            [styles.statusText, textStyle]
        } > {
            myDisplayAddr
        }({
            isConnected ? 'Online' : 'Offline'
        }) <
        /Text> {
            myPeerId && < Text style = {
                    [styles.peerIdText, textStyle]
                } > ID: {
                    myPeerId
                } < /Text>} <
                /View>

                <
                View style = {
                    styles.connectionArea
                } >
                <
                TextInput
            style = {
                [styles.input, styles.peerIdInput, textStyle]
            }
            placeholder = "Enter Peer ID to Connect"
            placeholderTextColor = {
                isDarkMode ? '#888' : '#999'
            }
            value = {
                targetPeerId
            }
            onChangeText = {
                setTargetPeerId
            }
            autoCapitalize = "none" /
                >
                <
                Button title = "Connect"
            onPress = {
                handleConnect
            }
            disabled = {
                !isConnected
            }
            /> <
            /View>

            <
            ScrollView
            style = {
                styles.messagesContainer
            }
            ref = {
                scrollViewRef
            }
            onContentSizeChange = {
                    () => scrollViewRef.current ? .scrollToEnd({
                        animated: true
                    })
                } > {
                    messages.map((msg) => ( <
                        View key = {
                            msg.id
                        }
                        style = {
                            styles.messageBubble(msg.from === 'You')
                        } > {
                            msg.type === 'system' ? ( <
                                Text style = {
                                    [styles.messageText, styles.systemMessage, textStyle]
                                } > {
                                    msg.text
                                } < /Text>
                            ) : ( <
                                >
                                <
                                Text style = {
                                    [styles.messageSender, textStyle]
                                } > {
                                    msg.from
                                } < /Text> <
                                Text style = {
                                    [styles.messageText, textStyle]
                                } > {
                                    msg.text
                                } < /Text> <
                                />
                            )
                        } <
                        /View>
                    ))
                } <
                /ScrollView>

                <
                View style = {
                    styles.inputArea
                } >
                <
                TextInput
            style = {
                [styles.input, styles.messageInput, textStyle]
            }
            placeholder = "Type your message..."
            placeholderTextColor = {
                isDarkMode ? '#888' : '#999'
            }
            value = {
                inputValue
            }
            onChangeText = {
                setInputValue
            }
            multiline
                /
                > {
                    /* Add Microphone button here later */ } <
                Button title = "Send"
            onPress = {
                sendTextMessage
            }
            disabled = {
                !isConnected || connectionsRef.current.size === 0
            }
            /> <
            /View> <
            /SafeAreaView>
        );
    }

    const styles = StyleSheet.create({
        header: {
            padding: 10,
            borderBottomWidth: 1,
            borderBottomColor: '#ccc',
            alignItems: 'center',
        },
        headerTitle: {
            fontSize: 20,
            fontWeight: 'bold',
        },
        statusText: {
            fontSize: 14,
            marginTop: 4,
        },
        peerIdText: {
            fontSize: 12,
            color: '#666',
            marginTop: 2,
        },
        connectionArea: {
            flexDirection: 'row',
            padding: 10,
            borderBottomWidth: 1,
            borderBottomColor: '#ccc',
            alignItems: 'center',
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
        messageBubble: (isOwnMessage) => ({
            maxWidth: '80%',
            padding: 10,
            borderRadius: 8,
            marginBottom: 8,
            alignSelf: isOwnMessage ? 'flex-end' : 'flex-start',
            backgroundColor: isOwnMessage ? '#DCF8C6' : '#FFF',
            // Add shadow/elevation for better appearance
            shadowColor: '#000',
            shadowOffset: {
                width: 0,
                height: 1
            },
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
            color: '#666',
            textAlign: 'center',
        },
        inputArea: {
            flexDirection: 'row',
            padding: 10,
            borderTopWidth: 1,
            borderTopColor: '#ccc',
            alignItems: 'center',
        },
        input: {
            borderWidth: 1,
            borderColor: '#ccc',
            borderRadius: 5,
            paddingHorizontal: 10,
            paddingVertical: 8,
            fontSize: 16,
            backgroundColor: '#fff', // Ensure input background is visible
        },
        messageInput: {
            flex: 1,
            marginRight: 10,
            maxHeight: 100, // Limit input height
        },
    });

    export default App;