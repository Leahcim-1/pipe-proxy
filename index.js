const net = require('net');
const fs = require('fs');
const { createLogger, format, transports }  = require('winston');
const { combine, timestamp, printf } = format;
const dotenv = require('dotenv')
const headerParses = require('http-headers');
/***
 * Configuration
 */
const ENV = dotenv.config({
    path: './.env'
}).parsed

const host = ENV.RUN_ENV === 'prod' ? '0.0.0.0' : '127.0.0.1'
const port = ENV.RUN_ENV === 'prod' ? 9528 : 3000

const logger  = createLogger({
    format: combine(
        timestamp(),
        printf(({level, timestamp, message}) =>  `[${level}]: ${message} | ${timestamp}`),
    ),
    transports: [
     new transports.Console(),
      new transports.File({ filename: 'error.log', level: 'error' }),
      new transports.File({ filename: 'warn.log', level: 'warn' }),
      new transports.File({ filename: 'proxy.log' }),
    ],
});
  

const httpPort = 80;
const httpsPort = 443;
const CONNECT = 'CONNECT';
const PROXY_AUTHORIZATION = 'proxy-authorization';
const HTTP_200 = 'HTTP/1.1 200 Connection Established\r\n\r\n'
const HTTP_407 = 'HTTP/1.1 407 Proxy Authentication Required\r\n\r\n';
const HTTP_500 = 'HTTP/1.1 500 Internal Server Error\r\n\r\n';



/**
 * Inspection
 */
if (!fs.existsSync('auth-list.json')) throw Error("No auth files");
const AUTH = JSON.parse(fs.readFileSync('auth-list.json', "utf8"));

const checkProxyAuth = (headers) => {
    // Check PROXY_AUTHORIZATION header
    if (!headers[PROXY_AUTHORIZATION]) return false;
    if (!headers[PROXY_AUTHORIZATION].includes('Basic ')) return false;

    // Validate Password and Username
    const authCode = headers[PROXY_AUTHORIZATION].split('Basic ')[1];
    if (!authCode) return false;
    const user = Buffer.from(authCode, 'base64').toString('utf8');
    if (!AUTH.AuthList.includes(user)) return false
    return true;
}


/**
 * Server
 */
const server = net.createServer()

server.setMaxListeners(20);

server.on('connection', clientToProxy => {
    clientToProxy.once('data', data => {
        const rawData = data.toString()
        const { method, headers } = headerParses(rawData);
        const possiblePort = method === CONNECT ? httpsPort : httpPort;
        const targetAddr = headers.host.split(':')[0];
        const targetPort = headers.host.split(':')[1] ? headers.host.split(':')[1] : possiblePort;
        logger.info(`${headers['user-agent']} -> ${method} ${targetAddr}:${targetPort}`);

        // Check Authorization
        const valid = checkProxyAuth(headers)

        if (!valid) {
            logger.warn(`Illegal: ${headers['user-agent']} -> ${method} ${targetAddr}:${targetPort}`)
            clientToProxy.write(HTTP_407);
            clientToProxy.end('Damn you!');
            return;
        }

        const proxyToServer = net.createConnection({
            port: targetPort, host: targetAddr
        },
            () => {
                logger.info(`Connected: ${headers['user-agent']} -> ${method} ${targetAddr}:${targetPort}`);
            }
        );

        // * If it is CONNECT, send HTTP OK to set up the tunnel
        // * Else transmit the data to target server
        if (method === CONNECT) clientToProxy.write(HTTP_200);
        else proxyToServer.write(data);


        // Pipe 
        clientToProxy.pipe(proxyToServer);
        proxyToServer.pipe(clientToProxy)

        // Error Handling
        proxyToServer.on('error', (err) => {
            logger.error(` ${method} ${targetAddr}:${targetPort}`, err);
        })

        clientToProxy.on('error', err => {
            logger.error(` ${method} ${targetAddr}:${targetPort}`, err);
        })
    })

    clientToProxy.on('error', err => {
        logger.error(`Connection Failed: ${err}`);
    })
})

server.listen(port, host, () => {
    logger.info(`PWC Proxy app listening on ${host}:${port}`)
})

server.on('error', err => {
    logger.error(`Server Error`, err);
})

server.on("close", () => {
    logger.info('Disconnected');
});