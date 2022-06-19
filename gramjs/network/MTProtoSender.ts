/**
 * MTProto Mobile Protocol sender
 * (https://core.telegram.org/mtproto/description)
 * This class is responsible for wrapping requests into `TLMessage`'s,
 * sending them over the network and receiving them in a safe manner.
 *
 * Automatic reconnection due to temporary network issues is a concern
 * for this class as well, including retry of messages that could not
 * be sent successfully.
 *
 * A new authorization key will be generated on connection if no other
 * key exists yet.
 */
import { AuthKey } from "../crypto/AuthKey";
import { MTProtoState } from "./MTProtoState";
import {
    BinaryReader,
    Logger,
    PromisedNetSockets,
    PromisedWebSockets,
} from "../extensions";
import { MessagePacker } from "../extensions";
import { GZIPPacked, MessageContainer, RPCResult, TLMessage } from "../tl/core";
import { Api } from "../tl";
import bigInt from "big-integer";
import { sleep } from "../Helpers";
import { RequestState } from "./RequestState";
import { doAuthentication } from "./Authenticator";
import { MTProtoPlainSender } from "./MTProtoPlainSender";
import {
    BadMessageError,
    TypeNotFoundError,
    InvalidBufferError,
    SecurityError,
    RPCMessageToError,
} from "../errors";
import { Connection, UpdateConnectionState } from "./";
import type { TelegramClient } from "..";
import { LogLevel } from "../extensions/Logger";

interface DEFAULT_OPTIONS {
    logger: any;
    retries: number;
    delay: number;
    autoReconnect: boolean;
    connectTimeout: any;
    authKeyCallback: any;
    updateCallback?: any;
    autoReconnectCallback?: any;
    isMainSender: boolean;
    dcId: number;
    senderCallback?: any;
    client: TelegramClient;
    onConnectionBreak?: CallableFunction;
    securityChecks: boolean;
}

export class MTProtoSender {
    static DEFAULT_OPTIONS = {
        logger: null,
        retries: Infinity,
        delay: 2000,
        autoReconnect: true,
        connectTimeout: null,
        authKeyCallback: null,
        updateCallback: null,
        autoReconnectCallback: null,
        isMainSender: null,
        senderCallback: null,
        onConnectionBreak: undefined,
        securityChecks: true,
    };
    _connection?: Connection;
    private readonly _log: Logger;
    private _dcId: number;
    private readonly _retries: number;
    private readonly _delay: number;
    private _connectTimeout: null;
    private _autoReconnect: boolean;
    private readonly _authKeyCallback: any;
    private readonly _updateCallback: (
        client: TelegramClient,
        update: UpdateConnectionState
    ) => void;
    private readonly _autoReconnectCallback?: any;
    private readonly _senderCallback: any;
    private readonly _isMainSender: boolean;
    _userConnected: boolean;
    _reconnecting: boolean;
    _disconnected: boolean;
    private _sendLoopHandle: any;
    private _recvLoopHandle: any;
    readonly authKey: AuthKey;
    private readonly _state: MTProtoState;
    private _sendQueue: MessagePacker;
    private _pendingState: Map<string, RequestState>;
    private readonly _pendingAck: Set<any>;
    private readonly _lastAcks: any[];
    private readonly _handlers: any;
    private readonly _client: TelegramClient;
    private readonly _onConnectionBreak?: CallableFunction;
    userDisconnected: boolean;
    isConnecting: boolean;
    _authenticated: boolean;
    private _securityChecks: boolean;

    /**
     * @param authKey
     * @param opts
     */
    constructor(authKey: undefined | AuthKey, opts: DEFAULT_OPTIONS) {
        const args = {
            ...MTProtoSender.DEFAULT_OPTIONS,
            ...opts,
        };
        this._connection = undefined;
        this._log = args.logger;
        this._dcId = args.dcId;
        this._retries = args.retries;
        this._delay = args.delay;
        this._autoReconnect = args.autoReconnect;
        this._connectTimeout = args.connectTimeout;
        this._authKeyCallback = args.authKeyCallback;
        this._updateCallback = args.updateCallback;
        this._autoReconnectCallback = args.autoReconnectCallback;
        this._isMainSender = args.isMainSender;
        this._senderCallback = args.senderCallback;
        this._client = args.client;
        this._onConnectionBreak = args.onConnectionBreak;
        this._securityChecks = args.securityChecks;

        /**
         * whether we disconnected ourself or telegram did it.
         */
        this.userDisconnected = false;

        /**
         * If a disconnection happens for any other reason and it
         * was *not* user action then the pending messages won't
         * be cleared but on explicit user disconnection all the
         * pending futures should be cancelled.
         */
        this.isConnecting = false;
        this._authenticated = false;
        this._userConnected = false;
        this._reconnecting = false;
        this._disconnected = true;

        /**
         * We need to join the loops upon disconnection
         */
        this._sendLoopHandle = null;
        this._recvLoopHandle = null;

        /**
         * Preserving the references of the AuthKey and state is important
         */
        this.authKey = authKey || new AuthKey();
        this._state = new MTProtoState(
            this.authKey,
            this._log,
            this._securityChecks
        );

        /**
         * Outgoing messages are put in a queue and sent in a batch.
         * Note that here we're also storing their ``_RequestState``.
         */
        this._sendQueue = new MessagePacker(this._state, this._log);

        /**
         * Sent states are remembered until a response is received.
         */
        this._pendingState = new Map<string, any>();

        /**
         * Responses must be acknowledged, and we can also batch these.
         */
        this._pendingAck = new Set();

        /**
         * Similar to pending_messages but only for the last acknowledges.
         * These can't go in pending_messages because no acknowledge for them
         * is received, but we may still need to resend their state on bad salts.
         */
        this._lastAcks = [];

        /**
         * Jump table from response ID to method that handles it
         */

        this._handlers = {
            [RPCResult.CONSTRUCTOR_ID.toString()]:
                this._handleRPCResult.bind(this),
            [MessageContainer.CONSTRUCTOR_ID.toString()]:
                this._handleContainer.bind(this),
            [GZIPPacked.CONSTRUCTOR_ID.toString()]:
                this._handleGzipPacked.bind(this),
            [Api.Pong.CONSTRUCTOR_ID.toString()]: this._handlePong.bind(this),
            [Api.BadServerSalt.CONSTRUCTOR_ID.toString()]:
                this._handleBadServerSalt.bind(this),
            [Api.BadMsgNotification.CONSTRUCTOR_ID.toString()]:
                this._handleBadNotification.bind(this),
            [Api.MsgDetailedInfo.CONSTRUCTOR_ID.toString()]:
                this._handleDetailedInfo.bind(this),
            [Api.MsgNewDetailedInfo.CONSTRUCTOR_ID.toString()]:
                this._handleNewDetailedInfo.bind(this),
            [Api.NewSessionCreated.CONSTRUCTOR_ID.toString()]:
                this._handleNewSessionCreated.bind(this),
            [Api.MsgsAck.CONSTRUCTOR_ID.toString()]: this._handleAck.bind(this),
            [Api.FutureSalts.CONSTRUCTOR_ID.toString()]:
                this._handleFutureSalts.bind(this),
            [Api.MsgsStateReq.CONSTRUCTOR_ID.toString()]:
                this._handleStateForgotten.bind(this),
            [Api.MsgResendReq.CONSTRUCTOR_ID.toString()]:
                this._handleStateForgotten.bind(this),
            [Api.MsgsAllInfo.CONSTRUCTOR_ID.toString()]:
                this._handleMsgAll.bind(this),
        };
    }

    set dcId(dcId: number) {
        this._dcId = dcId;
    }

    get dcId() {
        return this._dcId;
    }

    // Public API

    /**
     * Connects to the specified given connection using the given auth key.
     */
    async connect(connection: Connection, force?: boolean) {
        if (this._userConnected && !force) {
            this._log.info("User is already connected!");
            return false;
        }
        this.isConnecting = true;
        this._connection = connection;

        for (let attempt = 0; attempt < this._retries; attempt++) {
            try {
                await this._connect();
                if (this._updateCallback) {
                    this._updateCallback(
                        this._client,
                        new UpdateConnectionState(
                            UpdateConnectionState.connected
                        )
                    );
                }
                break;
            } catch (err) {
                if (this._updateCallback && attempt === 0) {
                    this._updateCallback(
                        this._client,
                        new UpdateConnectionState(
                            UpdateConnectionState.disconnected
                        )
                    );
                }
                this._log.error(
                    `WebSocket connection failed attempt: ${attempt + 1}`
                );
                if (this._log.canSend(LogLevel.ERROR)) {
                    console.error(err);
                }
                await sleep(this._delay);
            }
        }
        this.isConnecting = false;
        return true;
    }

    isConnected() {
        return this._userConnected;
    }

    /**
     * Cleanly disconnects the instance from the network, cancels
     * all pending requests, and closes the send and receive loops.
     */
    async disconnect() {
        this.userDisconnected = true;
        await this._disconnect();
    }

    /**
     *
     This method enqueues the given request to be sent. Its send
     state will be saved until a response arrives, and a ``Future``
     that will be resolved when the response arrives will be returned:

     .. code-block:: javascript

     async def method():
     # Sending (enqueued for the send loop)
     future = sender.send(request)
     # Receiving (waits for the receive loop to read the result)
     result = await future

     Designed like this because Telegram may send the response at
     any point, and it can send other items while one waits for it.
     Once the response for this future arrives, it is set with the
     received result, quite similar to how a ``receive()`` call
     would otherwise work.

     Since the receiving part is "built in" the future, it's
     impossible to await receive a result that was never sent.
     * @param request
     * @returns {RequestState}
     */
    send(request: Api.AnyRequest): any {
        if (!this._userConnected) {
            throw new Error(
                "Cannot send requests while disconnected. You need to call .connect()"
            );
        }
        const state = new RequestState(request);
        this._sendQueue.append(state);
        return state.promise;
    }

    /**
     * Performs the actual connection, retrying, generating the
     * authorization key if necessary, and starting the send and
     * receive loops.
     * @returns {Promise<void>}
     * @private
     */
    async _connect() {
        this._log.info(
            "Connecting to {0} using {1}"
                .replace("{0}", this._connection!.toString())
                .replace("{1}", this._connection!.socket.toString())
        );
        await this._connection!.connect();
        this._log.debug("Connection success!");

        if (!this.authKey.getKey()) {
            const plain = new MTProtoPlainSender(this._connection, this._log);
            this._log.debug("New auth_key attempt ...");
            const res = await doAuthentication(plain, this._log);
            this._log.debug("Generated new auth_key successfully");
            await this.authKey.setKey(res.authKey);

            this._state.timeOffset = res.timeOffset;

            /**
             * This is *EXTREMELY* important since we don't control
             * external references to the authorization key, we must
             * notify whenever we change it. This is crucial when we
             * switch to different data centers.
             */
            if (this._authKeyCallback) {
                await this._authKeyCallback(this.authKey, this._dcId);
            }
        } else {
            this._authenticated = true;
            this._log.debug("Already have an auth key ...");
        }
        this._userConnected = true;
        this._reconnecting = false;
        this._log.debug("Starting receive loop");
        this._recvLoopHandle = this._recvLoop();

        this._log.debug("Starting send loop");
        this._sendLoopHandle = this._sendLoop();

        // _disconnected only completes after manual disconnection
        // or errors after which the sender cannot continue such
        // as failing to reconnect or any unexpected error.

        this._log.info(
            "Connection to %s complete!".replace(
                "%s",
                this._connection!.toString()
            )
        );
    }

    async _disconnect(error = null) {
        this._sendQueue.rejectAll();

        if (this._connection === null) {
            this._log.info("Not disconnecting (already have no connection)");
            return;
        }
        if (this._updateCallback) {
            this._updateCallback(
                this._client,
                new UpdateConnectionState(UpdateConnectionState.disconnected)
            );
        }
        this._log.info(
            "Disconnecting from %s...".replace(
                "%s",
                this._connection!.toString()
            )
        );
        this._userConnected = false;
        this._log.debug("Closing current connection...");
        await this._connection!.disconnect();
    }

    /**
     * This loop is responsible for popping items off the send
     * queue, encrypting them, and sending them over the network.
     * Besides `connect`, only this method ever sends data.
     * @returns {Promise<void>}
     * @private
     */
    async _sendLoop() {
        this._sendQueue = new MessagePacker(this._state, this._log);

        while (this._userConnected && !this._reconnecting) {
            if (this._pendingAck.size) {
                const ack = new RequestState(
                    new Api.MsgsAck({ msgIds: Array(...this._pendingAck) })
                );
                this._sendQueue.append(ack);
                this._lastAcks.push(ack);
                if (this._lastAcks.length >= 10) {
                    this._lastAcks.shift();
                }
                this._pendingAck.clear();
            }
            this._log.debug(
                "Waiting for messages to send..." + this._reconnecting
            );
            // TODO Wait for the connection send queue to be empty?
            // This means that while it's not empty we can wait for
            // more messages to be added to the send queue.
            const res = await this._sendQueue.get();
            if (this._reconnecting) {
                this._log.debug("Reconnecting. will stop loop");
                return;
            }

            if (!res) {
                this._log.debug("Empty result. will not stop loop");
                continue;
            }
            let { data } = res;
            const { batch } = res;
            this._log.debug(
                `Encrypting ${batch.length} message(s) in ${data.length} bytes for sending`
            );

            data = await this._state.encryptMessageData(data);

            try {
                await this._connection!.send(data);
            } catch (e: any) {
                this._log.error(e);
                this._log.info("Connection closed while sending data");
                return;
            }
            for (const state of batch) {
                if (!Array.isArray(state)) {
                    if (state.request.classType === "request") {
                        this._pendingState.set(state.msgId.toString(), state);
                    }
                } else {
                    for (const s of state) {
                        if (s.request.classType === "request") {
                            this._pendingState.set(s.msgId.toString(), s);
                        }
                    }
                }
            }
            this._log.debug("Encrypted messages put in a queue to be sent");
        }
    }

    async _recvLoop() {
        let body;
        let message;

        while (this._userConnected && !this._reconnecting) {
            // this._log.debug('Receiving items from the network...');
            this._log.debug("Receiving items from the network...");
            try {
                body = await this._connection!.recv();
            } catch (e: any) {
                /** when the server disconnects us we want to reconnect */
                if (!this.userDisconnected) {
                    this._log.error(e);
                    this._log.warn("Connection closed while receiving data");
                    this.reconnect();
                }
                return;
            }
            try {
                message = await this._state.decryptMessageData(body);
            } catch (e: any) {
                if (e instanceof TypeNotFoundError) {
                    // Received object which we don't know how to deserialize
                    this._log.info(
                        `Type ${e.invalidConstructorId} not found, remaining data ${e.remaining}`
                    );
                    continue;
                } else if (e instanceof SecurityError) {
                    // A step while decoding had the incorrect data. This message
                    // should not be considered safe and it should be ignored.
                    this._log.warn(
                        `Security error while unpacking a received message: ${e}`
                    );
                    continue;
                } else if (e instanceof InvalidBufferError) {
                    // 404 means that the server has "forgotten" our auth key and we need to create a new one.
                    if (e.code === 404) {
                        this._log.warn(
                            `Broken authorization key for dc ${this._dcId}; resetting`
                        );
                        if (this._updateCallback && this._isMainSender) {
                            this._updateCallback(
                                this._client,
                                new UpdateConnectionState(
                                    UpdateConnectionState.broken
                                )
                            );
                        } else if (
                            this._onConnectionBreak &&
                            !this._isMainSender
                        ) {
                            // Deletes the current sender from the object
                            this._onConnectionBreak(this._dcId);
                        }
                    } else {
                        // this happens sometimes when telegram is having some internal issues.
                        // reconnecting should be enough usually
                        // since the data we sent and received is probably wrong now.
                        this._log.warn(
                            `Invalid buffer ${e.code} for dc ${this._dcId}`
                        );
                        this.reconnect();
                    }
                    return;
                } else {
                    this._log.error("Unhandled error while receiving data");
                    this._log.error(e);
                    this.reconnect();
                    return;
                }
            }
            try {
                await this._processMessage(message);
            } catch (e: any) {
                this._log.error("Unhandled error while receiving data");
                this._log.error(e);
            }
        }
    }

    // Response Handlers

    /**
     * Adds the given message to the list of messages that must be
     * acknowledged and dispatches control to different ``_handle_*``
     * method based on its type.
     * @param message
     * @returns {Promise<void>}
     * @private
     */
    async _processMessage(message: TLMessage) {
        this._pendingAck.add(message.msgId);

        message.obj = await message.obj;
        let handler = this._handlers[message.obj.CONSTRUCTOR_ID.toString()];
        if (!handler) {
            handler = this._handleUpdate.bind(this);
        }

        await handler(message);
    }

    /**
     * Pops the states known to match the given ID from pending messages.
     * This method should be used when the response isn't specific.
     * @param msgId
     * @returns {*[]}
     * @private
     */
    _popStates(msgId: bigInt.BigInteger) {
        let state = this._pendingState.get(msgId.toString());
        if (state) {
            this._pendingState.delete(msgId.toString());
            return [state];
        }

        const toPop = [];

        for (const state of this._pendingState.values()) {
            if (state.containerId && state.containerId.equals(msgId)) {
                toPop.push(state.msgId);
            }
        }

        if (toPop.length) {
            const temp = [];
            for (const x of toPop) {
                temp.push(this._pendingState.get(x!.toString()));
                this._pendingState.delete(x!.toString());
            }
            return temp;
        }

        for (const ack of this._lastAcks) {
            if (ack.msgId === msgId) {
                return [ack];
            }
        }

        return [];
    }

    /**
     * Handles the result for Remote Procedure Calls:
     * rpc_result#f35c6d01 req_msg_id:long result:bytes = RpcResult;
     * This is where the future results for sent requests are set.
     * @param message
     * @returns {Promise<void>}
     * @private
     */
    _handleRPCResult(message: TLMessage) {
        const RPCResult = message.obj;
        const state = this._pendingState.get(RPCResult.reqMsgId.toString());
        if (state) {
            this._pendingState.delete(RPCResult.reqMsgId.toString());
        }
        this._log.debug(
            `Handling RPC result for message ${RPCResult.reqMsgId}`
        );

        if (!state) {
            // TODO We should not get responses to things we never sent
            // However receiving a File() with empty bytes is "common".
            // See #658, #759 and #958. They seem to happen in a container
            // which contain the real response right after.
            try {
                const reader = new BinaryReader(RPCResult.body);
                if (!(reader.tgReadObject() instanceof Api.upload.File)) {
                    throw new Error("Not an upload.File");
                }
            } catch (e: any) {
                this._log.error(e);
                if (e instanceof TypeNotFoundError) {
                    this._log.info(
                        `Received response without parent request: ${RPCResult.body}`
                    );
                    return;
                } else {
                    throw e;
                }
            }
            return;
        }
        if (RPCResult.error && state.msgId) {
            const error = RPCMessageToError(RPCResult.error, state.request);
            this._sendQueue.append(
                new RequestState(new Api.MsgsAck({ msgIds: [state.msgId] }))
            );
            state.reject(error);
        } else {
            const reader = new BinaryReader(RPCResult.body);
            const read = state.request.readResult(reader);
            state.resolve(read);
        }
    }

    /**
     * Processes the inner messages of a container with many of them:
     * msg_container#73f1f8dc messages:vector<%Message> = MessageContainer;
     * @param message
     * @returns {Promise<void>}
     * @private
     */
    async _handleContainer(message: TLMessage) {
        this._log.debug("Handling container");
        for (const innerMessage of message.obj.messages) {
            await this._processMessage(innerMessage);
        }
    }

    /**
     * Unpacks the data from a gzipped object and processes it:
     * gzip_packed#3072cfa1 packed_data:bytes = Object;
     * @param message
     * @returns {Promise<void>}
     * @private
     */
    async _handleGzipPacked(message: TLMessage) {
        this._log.debug("Handling gzipped data");
        const reader = new BinaryReader(message.obj.data);
        message.obj = reader.tgReadObject();
        await this._processMessage(message);
    }

    async _handleUpdate(message: TLMessage) {
        if (message.obj.SUBCLASS_OF_ID !== 0x8af52aac) {
            // crc32(b'Updates')
            this._log.warn(
                `Note: ${message.obj.className} is not an update, not dispatching it`
            );
            return;
        }
        this._log.debug("Handling update " + message.obj.className);
        if (this._updateCallback) {
            this._updateCallback(this._client, message.obj);
        }
    }

    /**
     * Handles pong results, which don't come inside a ``RPCResult``
     * but are still sent through a request:
     * pong#347773c5 msg_id:long ping_id:long = Pong;
     * @param message
     * @returns {Promise<void>}
     * @private
     */
    async _handlePong(message: TLMessage) {
        const pong = message.obj;
        this._log.debug(`Handling pong for message ${pong.msgId}`);
        const state = this._pendingState.get(pong.msgId.toString());
        this._pendingState.delete(pong.msgId.toString());

        // Todo Check result
        if (state) {
            state.resolve(pong);
        }
    }

    /**
     * Corrects the currently used server salt to use the right value
     * before enqueuing the rejected message to be re-sent:
     * bad_server_salt#edab447b bad_msg_id:long bad_msg_seqno:int
     * error_code:int new_server_salt:long = BadMsgNotification;
     * @param message
     * @returns {Promise<void>}
     * @private
     */
    async _handleBadServerSalt(message: TLMessage) {
        const badSalt = message.obj;
        this._log.debug(`Handling bad salt for message ${badSalt.badMsgId}`);
        this._state.salt = badSalt.newServerSalt;
        const states = this._popStates(badSalt.badMsgId);
        this._sendQueue.extend(states);
        this._log.debug(`${states.length} message(s) will be resent`);
    }

    /**
     * Adjusts the current state to be correct based on the
     * received bad message notification whenever possible:
     * bad_msg_notification#a7eff811 bad_msg_id:long bad_msg_seqno:int
     * error_code:int = BadMsgNotification;
     * @param message
     * @returns {Promise<void>}
     * @private
     */
    async _handleBadNotification(message: TLMessage) {
        const badMsg = message.obj;
        const states = this._popStates(badMsg.badMsgId);
        this._log.debug(`Handling bad msg ${JSON.stringify(badMsg)}`);
        if ([16, 17].includes(badMsg.errorCode)) {
            // Sent msg_id too low or too high (respectively).
            // Use the current msg_id to determine the right time offset.
            const to = this._state.updateTimeOffset(bigInt(message.msgId));
            this._log.info(`System clock is wrong, set time offset to ${to}s`);
        } else if (badMsg.errorCode === 32) {
            // msg_seqno too low, so just pump it up by some "large" amount
            // TODO A better fix would be to start with a new fresh session ID
            this._state._sequence += 64;
        } else if (badMsg.errorCode === 33) {
            // msg_seqno too high never seems to happen but just in case
            this._state._sequence -= 16;
        } else {
            for (const state of states) {
                state.reject(
                    new BadMessageError(state.request, badMsg.errorCode)
                );
            }

            return;
        }
        // Messages are to be re-sent once we've corrected the issue
        this._sendQueue.extend(states);
        this._log.debug(
            `${states.length} messages will be resent due to bad msg`
        );
    }

    /**
     * Updates the current status with the received detailed information:
     * msg_detailed_info#276d3ec6 msg_id:long answer_msg_id:long
     * bytes:int status:int = MsgDetailedInfo;
     * @param message
     * @returns {Promise<void>}
     * @private
     */
    async _handleDetailedInfo(message: TLMessage) {
        // TODO https://goo.gl/VvpCC6
        const msgId = message.obj.answerMsgId;
        this._log.debug(`Handling detailed info for message ${msgId}`);
        this._pendingAck.add(msgId);
    }

    /**
     * Updates the current status with the received detailed information:
     * msg_new_detailed_info#809db6df answer_msg_id:long
     * bytes:int status:int = MsgDetailedInfo;
     * @param message
     * @returns {Promise<void>}
     * @private
     */
    async _handleNewDetailedInfo(message: TLMessage) {
        // TODO https://goo.gl/VvpCC6
        const msgId = message.obj.answerMsgId;
        this._log.debug(`Handling new detailed info for message ${msgId}`);
        this._pendingAck.add(msgId);
    }

    /**
     * Updates the current status with the received session information:
     * new_session_created#9ec20908 first_msg_id:long unique_id:long
     * server_salt:long = NewSession;
     * @param message
     * @returns {Promise<void>}
     * @private
     */
    async _handleNewSessionCreated(message: TLMessage) {
        // TODO https://goo.gl/LMyN7A
        this._log.debug("Handling new session created");
        this._state.salt = message.obj.serverSalt;
    }

    /**
     * Handles a server acknowledge about our messages. Normally
     * these can be ignored except in the case of ``auth.logOut``:
     *
     *     auth.logOut#5717da40 = Bool;
     *
     * Telegram doesn't seem to send its result so we need to confirm
     * it manually. No other request is known to have this behaviour.

     * Since the ID of sent messages consisting of a container is
     * never returned (unless on a bad notification), this method
     * also removes containers messages when any of their inner
     * messages are acknowledged.

     * @param message
     * @returns {Promise<void>}
     * @private
     */
    async _handleAck(message: TLMessage) {
        const ack = message.obj;
        this._log.debug(`Handling acknowledge for ${ack.msgIds}`);
        for (const msgId of ack.msgIds) {
            const state = this._pendingState.get(msgId);
            if (state && state.request instanceof Api.auth.LogOut) {
                this._pendingState.delete(msgId);
                state.resolve(true);
            }
        }
    }

    /**
     * Handles future salt results, which don't come inside a
     * ``rpc_result`` but are still sent through a request:
     *     future_salts#ae500895 req_msg_id:long now:int
     *     salts:vector<future_salt> = FutureSalts;
     * @param message
     * @returns {Promise<void>}
     * @private
     */
    async _handleFutureSalts(message: TLMessage) {
        // TODO save these salts and automatically adjust to the
        // correct one whenever the salt in use expires.
        this._log.debug(`Handling future salts for message ${message.msgId}`);
        const state = this._pendingState.get(message.msgId.toString());

        if (state) {
            this._pendingState.delete(message.msgId.toString());
            state.resolve(message.obj);
        }
    }

    /**
     * Handles both :tl:`MsgsStateReq` and :tl:`MsgResendReq` by
     * enqueuing a :tl:`MsgsStateInfo` to be sent at a later point.
     * @param message
     * @returns {Promise<void>}
     * @private
     */
    async _handleStateForgotten(message: TLMessage) {
        this._sendQueue.append(
            new RequestState(
                new Api.MsgsStateInfo({
                    reqMsgId: message.msgId,
                    info: String.fromCharCode(1).repeat(message.obj.msgIds),
                })
            )
        );
    }

    /**
     * Handles :tl:`MsgsAllInfo` by doing nothing (yet).
     * @param message
     * @returns {Promise<void>}
     * @private
     */
    async _handleMsgAll(message: TLMessage) {}

    reconnect() {
        if (this._userConnected && !this._reconnecting) {
            this._reconnecting = true;
            // TODO Should we set this?
            // this._user_connected = false
            // we want to wait a second between each reconnect try to not flood the server with reconnects
            // in case of internal server issues.
            sleep(1000).then(() => {
                this._log.info("Started reconnecting");
                this._reconnect();
            });
        }
    }

    async _reconnect() {
        this._log.debug("Closing current connection...");
        try {
            await this.disconnect();
        } catch (err: any) {
            this._log.warn(err);
        }
        // @ts-ignore
        this._sendQueue.append(undefined);
        this._state.reset();

        // For some reason reusing existing connection caused stuck requests
        const constructor = this._connection!
            .constructor as unknown as typeof Connection;
        const socket = this._connection!.socket.constructor as
            | typeof PromisedNetSockets
            | typeof PromisedWebSockets;
        const newConnection = new constructor({
            ip: this._connection!._ip,
            port: this._connection!._port,
            dcId: this._connection!._dcId,
            loggers: this._connection!._log,
            proxy: this._connection!._proxy,
            testServers: this._connection!._testServers,
            socket: socket,
        });
        await this.connect(newConnection, true);

        this._reconnecting = false;
        this._sendQueue.extend(Array.from(this._pendingState.values()));
        this._pendingState = new Map<string, RequestState>();
        if (this._autoReconnectCallback) {
            this._autoReconnectCallback();
        }
    }
}
