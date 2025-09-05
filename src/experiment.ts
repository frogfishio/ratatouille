import Topic from "./topic";

// Simple demo of Topic usage to ensure compile/run works
const debug = Topic("debug#random", { svc: "api" });
debug("hello world", { user: "alice" }, { requestId: 123 }, "extra arg");



// const relay = new Relay("tcp://127.0.0.1:9000");
// await relay.connect();

// const debug = new Topic("debug", { svc: "api" }, relay);
// debug("hello via relay");

// relay.close();