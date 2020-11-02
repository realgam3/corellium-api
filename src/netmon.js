const WebSocket = require('ws');
const {fetchApi} = require('./util/fetch');

/**
 * A connection to the network monitor running on an instance.
 *
 * Instances of this class
 * are returned from {@link Instance#networkMonitor} and {@link Instance#newNetworkMonitor}. They
 * should not be created using the constructor.
 * @hideconstructor
 */
class NetworkMonitor {
    constructor(instance) {
        this.instance = instance;
        this.connected = false;
        this.connectPromise = null;
        this.id = 0;
        this.handler = null;
        this._keepAliveTimeout = null;
        this._lastPong = null;
        this._lastPing = null;
    }

    /**
     * Ensure the network monitor is connected.
     * @private
     */
    async connect() {
        this.pendingConnect = true;
        if (!this.connected)
            await this.reconnect();
    }

    /**
     * Ensure the network monitor is disconnected, then connect the network monitor.
     * @private
     */
    async reconnect() {
        if (this.connected)
            this.disconnect();

        if (this.connectPromise)
            return this.connectPromise;

        this.connectPromise = (async () => {
            while (this.pendingConnect) {
                try {
                    await this._connect();
                    break;
                } catch (e) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }

            this.connectPromise = null;
        })();

        return this.connectPromise;
    }

    async _connect() {
        this.pending = new Map();

        const endpoint = await this.instance.netmonEndpoint();
        
        // Detect if a disconnection happened before we were able to get the network monitor endpoint.
        if (!this.pendingConnect)
            throw new Error('connection cancelled');

        let ws = new WebSocket(endpoint);

        this.ws = ws;

        ws.on('message', data => {
            try {
                let message;
                let id;
                if (typeof data === 'string') {
                    message = JSON.parse(data);
                    id = message['id'];
                } else if (data.length >= 8) {
                    id = data.readUInt32LE(0);
                    message = data.slice(8);
                }

                let handler = this.handler;
                if (handler) {
                    Promise.resolve(handler(message)).then(shouldDelete => {
                        if (shouldDelete)
                            this.pending.delete(id);
                    });
                }
            } catch (err) {
                console.error('error in agent message handler', err);
            }
        });

        ws.on('close', (code, reason) => {
            this.pending.forEach(handler => {
                handler(new Error(`disconnected ${reason}`));
            });
            this.pending = new Map();
            this._disconnect();
        });

        await new Promise((resolve, reject) => {
            ws.once('open', () => {
                if (this.ws !== ws) {
                    try {
                        ws.close();
                    } catch (e) {}

                    reject(new Error('connection cancelled'));
                    return;
                }

                ws.on('error', err => {
                    this.pending.forEach(handler => {
                        handler(err);
                    });
                    this.pending = new Map();

                    if (this.ws === ws) {
                        this._disconnect();
                    } else {
                        try {
                            ws.close();
                        } catch (e) {}
                    }

                    console.error('error in netmon socket', err);
                });

                resolve();
            });

            ws.once('error', err => {
                if (this.ws === ws) {
                    this._disconnect();
                } else {
                    try {
                        ws.close();
                    } catch (e) {}
                }

                reject(err);
            });
        });

        this.connected = true;
        this._startKeepAlive();
    }

    _startKeepAlive() {
        if (!this.connected)
            return;

        let ws = this.ws;

        ws.ping();

        this._keepAliveTimeout = setTimeout(() => {
            if (this.ws !== ws) {
                try {
                    ws.close();
                } catch (e) {}
                return;
            }

            let err = new Error('Netmon did not get a response to pong in 10 seconds, disconnecting.');
            console.error('Netmon did not get a response to pong in 10 seconds, disconnecting.');

            this.pending.forEach(handler => {
                handler(err);
            });
            this.pending = new Map();

            this._disconnect();
        }, 10000);

        ws.once('pong', async () => {
            if (ws !== this.ws)
                return;

            clearTimeout(this._keepAliveTimeout);
            this._keepAliveTimeout = null;

            await new Promise(resolve => setTimeout(resolve, 10000));

            this._startKeepAlive();
        });
    }

    _stopKeepAlive() {
        if (this._keepAliveTimeout) {
            clearTimeout(this._keepAliveTimeout);
            this._keepAliveTimeout = null;
        }
    }

    /**
     * Disconnect an network monitor connection. This is usually only required if a new
     * network monitor connection has been created and is no longer needed
     */
    disconnect() {
        this.pendingConnect = false;
        this._disconnect();
    }

    _disconnect() {
        this.connected = false;
        this.handler = null;
        this._stopKeepAlive();
        if (this.ws) {
            try {
                this.ws.close();
            } catch (e) {}
            this.ws = null;
        }
    }

    /** Start Network Monitor */
    async start() {
        await this.connect();        
        await this._fetch('/sslsplit/enable', {method: 'POST'});
    }

    /** Set message handler */
    async handleMessage(handler) {
        this.handler = handler;
    }

    /** Clear NetworkMonitor log*/
    async clearLog() {
        let disconnectAfter = false;
        if (!this.connected) {
            await this.connect();
            disconnectAfter = true;
        }
        await this.ws.send(JSON.stringify({"type": "clear"}));
        if (disconnectAfter) {
            await this.disconnect();
        }
    }

    /** Stop Network Monitor */
    async stop() {
        await this._fetch('/sslsplit/disable', {method: 'POST'});
        await this.disconnect();
    }

    async _fetch(endpoint = '', options = {}) {
        return await fetchApi(this.instance.project, `/instances/${this.instance.id}${endpoint}`, options);
    }
}

module.exports = NetworkMonitor;