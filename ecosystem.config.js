module.exports = {
    apps: [
        {
            name: "node-1",
            script: "apps/blockchain/server.js",
            cwd: ".",
            watch: false,
            env: {
                NODE_ENV: "production",
                PORT: 3000,
                P2P_PORT: 3001,
                PEERS: "[]"
            },
            autorestart: true,
            restart_delay: 2000,
        },
        {
            name: "miner-1",
            script: "apps/miner/server.js",
            args: "--address 0a0cf279ea90a30a5cfc8593376146b5bcde7564",
            cwd: ".",
            watch: false,
            env: {
                NODE_ENV: "production",
                NODE_URL: "http://localhost:3000"
            },
            autorestart: true,
            restart_delay: 2000,
        },
        {
            name: "scanner-web",
            script: "apps/scanner/webserver.js",
            cwd: ".",
            watch: false,
            env: {
                NODE_ENV: "production",
                NODE_URL: "http://localhost:3000",
                NODE_WS: "http://localhost:3001",
                SCANNER_PORT: 5000
            },
            autorestart: true,
            restart_delay: 2000,
        },
    ],
};
