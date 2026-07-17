const assert = require("node:assert/strict");
const { decodeSocketIoAttachment, decryptConfigValue, parseSocketIoText } = require("../socketio_probe");

const SAMPLE_ATTACHMENT =
  "BAKAAVUyRnNkR1ZrWDE4azZ6S2pmUkMySUVKWmpRaktrWmIyc05tdEJLd29KZ1pnNWxvai9lZ1E5NE9haSsrOGxVa1lBdGlmSjR0a2dlOW0rc01yQ24wSXhiRFNWd2xQUlJ6Slh4bWJ6azdlZGFTanNjRkV5TUl5czlBOUdWcFNKTDBY" +
  "Cg1nYW1lLTkyMTE0MzAz";

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}

test("decrypts bundled config secrets", () => {
  assert.equal(decryptConfigValue("46tNyEi77HTO0sVXfBbKFg=="), "ninthArt@999");
  assert.equal(decryptConfigValue("bvg+guK0U9HuplptwRQhPfupNyznrHDwKqXskJoBBJfxTj2f3mPmgOs752eD9GkX"), "wss://dt.shipin1hao.com:9999/9009");
});

test("decodes captured AuthRequest attachment", () => {
  const decoded = decodeSocketIoAttachment(SAMPLE_ATTACHMENT);

  assert.equal(decoded.webMessage.account, "game-92114303");
  assert.equal(decoded.requestMessage.session, "OTIxMTQzMDM=.c239103d653029bb1af5f1fd3f1ee919");
  assert.equal(decoded.eventGuess, "AuthRequest");
  assert.deepEqual(decoded.bodyDecoded, {
    account: "92114303",
    token: "",
    clientType: 0,
    version: "",
  });
});

test("parses Socket.IO binary event text prefix", () => {
  assert.deepEqual(parseSocketIoText('451-["TableInfoReplay",{"_placeholder":true,"num":0}]'), {
    eventName: "TableInfoReplay",
    payload: ["TableInfoReplay", { _placeholder: true, num: 0 }],
  });
});
