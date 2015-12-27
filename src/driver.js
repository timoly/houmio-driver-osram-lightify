// modified from http://sarajarvi.org/lightify-haltuun/

var Bacon = require('baconjs')
var carrier = require('carrier')
var net = require('net')
var winston = require('winston')
winston.remove(winston.transports.Console)

winston.add(winston.transports.Console, {
  timestamp: (function() {
    return new Date()
  })
})

console.log = winston.info

var houmioBridge = process.env.HOUMIO_BRIDGE || "localhost:3001"
var lightifyBridge = process.env.LIGHTIFY_BRIDGE || '192.168.2.102'
console.log("houmioBridge:", houmioBridge, "lightifyBridge:", lightifyBridge)

var lightifySocket = new net.Socket()
lightifySocket.connect(4000, lightifyBridge, function(){
  console.log('lightify connected')
  queryBulbs()
})

var lightifyCommandBus = new Bacon.Bus()

var d2h = function(d){
  var hex = Number(d).toString(16)
  padding = typeof (padding) === "undefined" || padding === null ? padding = 2 : padding

  while (hex.length < 2) {
    hex = "0" + hex
  }

  return hex
}

var splitAddress = function(addr){
  return addr.split(":").reverse()
}

// HSL->RGB code found & modified from:
// http://www.brandonheyer.com/2013/03/27/convert-hsl-to-rgb-and-rgb-to-hsl-via-php/
// Sets color by hue and lightness: hue should be 0-360, lightness 0-100
// Lightness at 0 will be pure color, 50 has 50%/50% color+white and 100 is white
var hueWithLightness = function(addr, hue, lightness){
  var l = ((lightness / 2) + 50) / 100

  var s = 1
  var c = (1 - Math.abs(2 * l - 1)) * s
  var x = c * (1 - Math.abs(((hue / 60) % 2) - 1))
  var m = l - (c / 2)

  if(hue < 60) {
    var r = c
    var g = x
    var b = 0
  }
  else if(hue < 120) {
    r = x
    g = c
    b = 0
  }
  else if(hue < 180) {
    r = 0
    g = c
    b = x
  }
  else if(hue < 240) {
    r = 0
    g = x
    b = c
  }
  else if(hue < 300) {
    r = x
    g = 0
    b = c
  }
  else {
    r = c
    g = 0
    b = x
  }

  r = Math.floor((r + m) * 255)
  g = Math.floor((g + m) * 255)
  b = Math.floor((b + m) * 255)

  rgbColors(addr, r, g, b)
}

lightifyCommandBus
.bufferingThrottle(250)
.onValue(function(cmd){
  var action = [d2h(cmd.length), '00'].concat(cmd)
  lightifySocket.write(action.join(''), 'hex')
})

// Turns bulb on or off: value is boolean
var state = function(addr, state){
  var cmd = ['00', '32', '00', '00', '00', '00'].concat(splitAddress(addr)).concat([state? '01' : '00'])
  lightifyCommandBus.push(cmd)
}

// Sets brightness: value should be 1-100 (0 turns bulb off)
var brightness = function(addr, value){
  var cmd = ['00', '31', '00', '00', '00', '00'].concat(splitAddress(addr)).concat(d2h(value)).concat(['00', '00'])
  lightifyCommandBus.push(cmd)
}

// Sets color temperature: value should be 2200-6500 (in Kelvin w/o K)
var colorTemperature = function(addr, temp){
  var temperature = d2h(temp)
  temperature = temperature.length < 4? '0' + temperature : temperature
  var temperatureArray = temperature.match(/.{1,2}/g)
  var cmd =  ['00', '33', '00', '00', '00', '00'].concat(splitAddress(addr)).concat(temperatureArray.reverse()).concat(['00', '00'])
  lightifyCommandBus.push(cmd)
}

// Sets color by RGB values: red/green/blue should be 0-255
// Notice how bulb behaves: 0,0,127 isn't blue at 50% brightness
var rgbColors = function(addr, red, green, blue){
  var color = [d2h(red), d2h(green), d2h(blue)]
  var cmd = ['00', '36', '00', '00', '00', '00'].concat(splitAddress(addr)).concat(color).concat(['ff', '00', '00'])
  lightifyCommandBus.push(cmd)
}

var queryBulbs = function(){
  var h2d = function(h){
    return parseInt(h,16)
  }

  var name = function(hexArray){
    var result = hexArray.map(function(hex){
      return String.fromCharCode(h2d(hex))
    })

    return result.join('').replace(/\u0000/g, '').trim()
  }

  var chrsToAddress = function(chrs){
    return chrs.reverse().join(":")
  }

  var bulbLength = 50
  var cmd = ['00', '13', '00', '00', '00', '00', '01', '00', '00', '00', '00']
  lightifyCommandBus.push(cmd)

  lightifySocket.once('data', function(data){
    var buffer = data.toString('hex').match(/.{1,2}/g)

    if(buffer.length > 11){
      buffer = buffer.slice(11)
      var bulbCount = Math.floor(buffer.length / bulbLength)

      for(var i=0;i<bulbCount;i++){
        var chunk = buffer.slice(bulbLength * i, bulbLength * i + bulbLength)
        var mac = chrsToAddress(chunk.slice(2, 10))
        console.log("bulb:", name(chunk.slice(26, 41)), "mac:", mac)
      }
    }
  })
}

var toLines = function(socket) {
  return Bacon.fromBinder(function(sink){
    carrier.carry(socket, sink)

    socket.on("close", function() {
      return sink(new Bacon.End())
    })

    socket.on("error", function(err) {
      return sink(new Bacon.Error(err))
    })

    return function(){}
  })
}

var isWriteMessage = function(message){
  return message.command === "write"
}

var scaleByteToPercent = function(oldValue){
  var oldMin = 0
  var oldMax = 255
  var newMin = 0
  var newMax = 100

  return Math.floor((((oldValue - oldMin) * (newMax - newMin)) / (oldMax - oldMin)) + newMin)
}

var scaleByteTo359 = function(oldValue){
  var oldMin = 0
  var oldMax = 255
  var newMin = 0
  var newMax = 359

  return Math.floor((((oldValue - oldMin) * (newMax - newMin)) / (oldMax - oldMin)) + newMin)
}

var writeMessagesToLightify = function(bridgeSocket){
  return toLines(bridgeSocket)
  .map(JSON.parse)
  .filter(isWriteMessage)
  .onValue(function(msg){
    // console.log("houmio cmd:", msg)

    if(msg.data.on) {
      brightness(msg.data.protocolAddress, scaleByteToPercent(msg.data.bri))
    }
    else{
      state(msg.data.protocolAddress, false)
    }

    if(msg.data.hue && msg.data.saturation === 0){
      colorTemperature(msg.data.protocolAddress, 2200 + 4300 * scaleByteToPercent(msg.data.hue) / 100)
    }
    //TODO color
    //hueWithLightness(msg.data.protocolAddress, scaleByteTo359(msg.data.hue), 100 - scaleByteToPercent(msg.data.saturation))
  })
}

var connectBridge = function() {
    var bridgeSocket = new net.Socket()
    bridgeSocket.connect(houmioBridge.split(":")[1], houmioBridge.split(":")[0], function(){
      writeMessagesToLightify(bridgeSocket)
      return bridgeSocket.write((JSON.stringify({
        command: "driverReady",
        protocol: "lightify"
      })) + "\n")
    })
}

connectBridge()
