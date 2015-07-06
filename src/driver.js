// modified from http://sarajarvi.org/lightify-haltuun/

var Bacon = require('baconjs');
var carrier = require('carrier');
var net = require('net');
var winston = require('winston');
winston.remove(winston.transports.Console);

winston.add(winston.transports.Console, {
  timestamp: (function() {
    return new Date();
  })
});

console.log = winston.info;

var houmioBridge = process.env.HOUMIO_BRIDGE || "localhost:3001"
var lightifyBridge = process.env.LIGHTIFY_BRIDGE || '192.168.2.102'
console.log("houmioBridge:", houmioBridge, "lightifyBridge:", lightifyBridge)

var lightifySocket = new net.Socket();
lightifySocket.connect(4000, lightifyBridge, function(){
  console.log('ligtify connected');
});

var d2h = function(d){
  var hex = Number(d).toString(16);
  padding = typeof (padding) === "undefined" || padding === null ? padding = 2 : padding;

  while (hex.length < 2) {
    hex = "0" + hex;
  }

  return hex;
}

var splitAddress = function(addr){
  var addr = addr.split(":")
  addr.reverse()

  return addr
}

// HSL->RGB code found & modified from:
// http://www.brandonheyer.com/2013/03/27/convert-hsl-to-rgb-and-rgb-to-hsl-via-php/
// Sets color by hue and lightness: hue should be 0-360, lightness 0-100
// Lightness at 0 will be pure color, 50 has 50%/50% color+white and 100 is white
var hueWithLightness = function(addr, hue, lightness){
  var l = ((lightness / 2) + 50) / 100;

  var s = 1;
  var c = (1 - Math.abs(2 * l - 1)) * s;
  var x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  var m = l - (c / 2);

  if(hue < 60) {
    var r = c;
    var g = x;
    var b = 0;
  }
  else if(hue < 120) {
    r = x;
    g = c;
    b = 0;
  }
  else if(hue < 180) {
    r = 0;
    g = c;
    b = x;
  }
  else if(hue < 240) {
    r = 0;
    g = x;
    b = c;
  }
  else if(hue < 300) {
    r = x;
    g = 0;
    b = c;
  }
  else {
    r = c;
    g = 0;
    b = x;
  }

  r = Math.floor((r + m) * 255);
  g = Math.floor((g + m) * 255);
  b = Math.floor((b + m) * 255);

  rgbColors(addr, r, g, b);
};

var sendCommand = function(cmd){
  var action = [d2h(cmd.length), '00'].concat(cmd)
  lightifySocket.write(action.join(''), 'hex')
}

// Turns bulb on or off: value is boolean
var state = function(addr, state){
  var cmd = ['00', '32', '00', '00', '00', '00'].concat(splitAddress(addr)).concat([state? '01' : '00'])
  sendCommand(cmd)
};

// Sets brightness: value should be 1-100 (0 turns bulb off)
var brightness = function(addr, value){
  var cmd = ['00', '31', '00', '00', '00', '00'].concat(splitAddress(addr)).concat(d2h(value)).concat(['00', '00'])
  sendCommand(cmd);
};

// Sets color temperature: value should be 2200-6500 (in Kelvin w/o K)
var colorTemperature = function(addr, temp){
  var temperature = d2h(temp)
  temperature = temperature.length < 4? '0' + temperature : temperature
  var temperatureArray = temperature.match(/.{1,2}/g)
  var cmd =  ['00', '33', '00', '00', '00', '00'].concat(splitAddress(addr)).concat(temperatureArray.reverse()).concat(['00', '00'])
  sendCommand(cmd);
};

// Sets color by RGB values: red/green/blue should be 0-255
// Notice how bulb behaves: 0,0,127 isn't blue at 50% brightness
var rgbColors = function(addr, red, green, blue){
  var color = [d2h(red), d2h(green), d2h(blue)]
  var cmd = ['00', '36', '00', '00', '00', '00'].concat(splitAddress(addr)).concat(color).concat(['ff', '00', '00'])
  sendCommand(cmd);
};

var exit = function(msg) {
  console.log(msg);
  return process.exit(1);
};

var displayResult = function(result) {
  return console.log(JSON.stringify(result, null, 2));
};

var displayError = function(err) {
  return console.error(err);
};

var toLines = function(socket) {
  return Bacon.fromBinder(function(sink) {
    carrier.carry(socket, sink);
    socket.on("close", function() {
      return sink(new Bacon.End());
    });
    socket.on("error", function(err) {
      return sink(new Bacon.Error(err));
    });
    return function() {};
  });
};

var isWriteMessage = function(message) {
  return message.command === "write";
};

var scaleByteToPercent = function(oldValue) {
  var newMax, newMin, oldMax, oldMin;
  oldMin = 0;
  oldMax = 255;
  newMin = 0;
  newMax = 100;
  return Math.floor((((oldValue - oldMin) * (newMax - newMin)) / (oldMax - oldMin)) + newMin);
};

var scaleByteTo359 = function(oldValue) {
  var newMax, newMin, oldMax, oldMin;
  oldMin = 0;
  oldMax = 255;
  newMin = 0;
  newMax = 359;
  return Math.floor((((oldValue - oldMin) * (newMax - newMin)) / (oldMax - oldMin)) + newMin);
};

var writeMessagesToLightify = function(bridgeSocket) {
  return toLines(bridgeSocket).map(JSON.parse).filter(isWriteMessage).onValue(function(msg) {
    if(msg.data.on) {
      brightness(msg.data.protocolAddress, scaleByteToPercent(msg.data.bri));
    }
    else{
      state(msg.data.protocolAddress, false)
    }

    if(msg.data.hue && msg.data.saturation){
      hueWithLightness(msg.data.protocolAddress, scaleByteTo359(msg.data.hue), 0)
    }
  });
};

var connectBridge = function() {
    var bridgeSocket = new net.Socket();
    bridgeSocket.connect(houmioBridge.split(":")[1], houmioBridge.split(":")[0], function(){
      console.log("connected", houmioBridge)

      writeMessagesToLightify(bridgeSocket);
      return bridgeSocket.write((JSON.stringify({
        command: "driverReady",
        protocol: "lightify"
      })) + "\n");
    });
};

connectBridge()
