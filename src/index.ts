import * as net from "net";
import * as dns from "dns";
import * as process from "process";
import { Server, Socket } from "socket.io";
import * as uuid from "uuid";
import _ from "lodash";

const PRODUCTION = process.env.NODE_ENV === "production";

const PORT_FIRST = 62300;
const PORT_LAST = 62325;
const SOCKET_IO_PORT = 4000;
const TCP_CONNECT_TIMEOUT = 10 * 60 * 1000;

const LOOPBACK_ADDRESS = "0.0.0.0";
let SERVER_ADDRESS = "127.0.0.1";
if (PRODUCTION) {
  dns.promises.resolve4("api.rs.tyilo.com").then((addresses) => {
    SERVER_ADDRESS = addresses[0];
  });
}
const IO_OPTIONS = PRODUCTION
  ? {
      cors: {
        origin: "https://rs.tyilo.com",
        methods: ["GET", "POST"],
      },
    }
  : {};

const io = new Server(SOCKET_IO_PORT, IO_OPTIONS);
console.log(`Listening on port ${SOCKET_IO_PORT} for socket.io connections...`);

const FREE_PORTS = new Set<number>(_.range(PORT_FIRST, PORT_LAST + 1));

function getPort(): number {
  if (FREE_PORTS.size === 0) {
    throw new Error("No free ports available!");
  }

  const index = _.random(0, FREE_PORTS.size - 1);
  let i = 0;
  for (let value of FREE_PORTS) {
    if (i === index) {
      FREE_PORTS.delete(value);
      return value;
    }

    i++;
  }

  throw new Error("Shouldn't happen.");
}

const CONNECTION_MAP = new Map<string, TcpConnection>();

class TcpConnection {
  public id: string;
  public ioSocket: Socket;
  public tcpPort: number;
  public tcpSocket?: net.Socket;
  public tcpSocketConnected: boolean = false;

  constructor(id: string, ioSocket: Socket) {
    this.id = id;
    this.ioSocket = ioSocket;
    this.tcpPort = getPort();

    const tcpServer = net.createServer((tcpSocket: net.Socket) => {
      tcpServer.close();
      this.tcpSocket = tcpSocket;
      this.tcpSocketConnected = true;
      console.log(`TCP socket connected on port ${this.tcpPort}.`);
      FREE_PORTS.add(this.tcpPort);
      this.onTcpConnect();
    });

    tcpServer.listen(this.tcpPort, LOOPBACK_ADDRESS);

    console.log(`Listening for TCP connection on port ${this.tcpPort}.`);

    CONNECTION_MAP.set(this.id, this);

    this.sendConfig();

    setTimeout(() => {
      if (!this.tcpSocketConnected) {
        console.log(
          `Expired waiting for TCP connection on port ${this.tcpPort}.`
        );
        tcpServer.close();
        this.ioSocket.emit("shellConnectTimeout");
        FREE_PORTS.add(this.tcpPort);
        CONNECTION_MAP.delete(this.id);
      }
    }, TCP_CONNECT_TIMEOUT);
  }

  private onTcpConnect() {
    if (!this.tcpSocket) {
      return;
    }

    this.tcpSocket.on("data", (data: Buffer) => {
      this.ioSocket.emit("shellData", data);
    });

    this.tcpSocket.on("error", (err: Error) => {
      console.log(`Got TCP error: ${err}`);
    });

    this.tcpSocket.on("close", () => {
      this.ioSocket.emit("shellDisconnected");
      CONNECTION_MAP.delete(this.id);
    });

    this.setupIOSocketHandlers();
  }

  private sendConfig() {
    this.ioSocket.emit("config", {
      address: SERVER_ADDRESS,
      port: this.tcpPort,
    });
  }

  private setupIOSocketHandlers() {
    this.ioSocket.emit("shellConnected");

    this.ioSocket.on("char", (c: any) => {
      if (this.tcpSocket) {
        this.tcpSocket.write(c);
      }
    });
  }

  public setIOSocket(ioSocket: Socket) {
    this.ioSocket = ioSocket;
    this.sendConfig();
    if (this.tcpSocket) {
      this.setupIOSocketHandlers();
    }
  }
}

io.on("connection", (ioSocket: Socket) => {
  const id = ioSocket.handshake.query.id;
  if (typeof id !== "string" || !uuid.validate(id)) {
    console.log(`Invalid id in query: ${id}`);
    ioSocket.disconnect();
    return;
  }

  console.log(`socket.io user connected: ${id}`);

  let connection = CONNECTION_MAP.get(id);
  if (connection) {
    console.log("Reusing existing connection...");
    connection.setIOSocket(ioSocket);
  } else {
    connection = new TcpConnection(id, ioSocket);
  }
});
