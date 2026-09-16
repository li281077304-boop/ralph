#!/usr/bin/env swift

import Cocoa
import ApplicationServices

struct Request: Decodable {
  let message: String
  let identity: String
  let closing_marker: String
  let timeout_ms: Int
}

struct Response: Encodable {
  let ok: Bool
  let reply: String?
  let errorCode: String?
  let error: String?
  let diagnostics: [String: String]?
}

func emit(_ response: Response) {
  let encoder = JSONEncoder()
  if let data = try? encoder.encode(response), let text = String(data: data, encoding: .utf8) {
    print(text)
  }
}

func readAttribute(_ element: AXUIElement, _ key: CFString) -> CFTypeRef? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, key, &value) == .success else { return nil }
  return value
}

func stringAttribute(_ element: AXUIElement, _ key: CFString) -> String {
  guard let value = readAttribute(element, key) else { return "" }
  return String(describing: value)
}

func children(_ element: AXUIElement) -> [AXUIElement] {
  (readAttribute(element, kAXChildrenAttribute as CFString) as? [AXUIElement]) ?? []
}

func frontChromeWindow() -> AXUIElement? {
  guard let app = NSWorkspace.shared.runningApplications.first(where: {
    $0.bundleIdentifier == "com.google.Chrome" && $0.isActive
  }) else { return nil }
  let application = AXUIElementCreateApplication(app.processIdentifier)
  AXUIElementSetMessagingTimeout(application, 0.75)
  guard let window = readAttribute(application, kAXFocusedWindowAttribute as CFString) as! AXUIElement? else { return nil }
  AXUIElementSetMessagingTimeout(window, 0.75)
  return window
}

func snapshot(window: AXUIElement) -> (texts: [String], stopVisible: Bool, webAreas: Int, webCharacters: Int) {
  var queue: [(AXUIElement, Int)] = [(window, 0)]
  var texts: [String] = []
  var stopVisible = false
  var webAreas = 0
  var webCharacters = 0
  var visited = 0
  while !queue.isEmpty && visited < 500 {
    let (element, depth) = queue.removeFirst()
    visited += 1
    let role = stringAttribute(element, kAXRoleAttribute as CFString)
    let title = stringAttribute(element, kAXTitleAttribute as CFString)
    let value = stringAttribute(element, kAXValueAttribute as CFString)
    let content = [title, value].filter { !$0.isEmpty }.joined(separator: " ")
    if role.contains("AXWebArea") {
      webAreas += 1
      if let number = readAttribute(element, kAXNumberOfCharactersAttribute as CFString) as? NSNumber {
        webCharacters += number.intValue
      }
    }
    if role.contains("AXStaticText") || role.contains("AXTextArea") || role.contains("AXTextField") {
      if !content.isEmpty { texts.append(content) }
    }
    if role.contains("AXButton") && (content.localizedCaseInsensitiveContains("stop") || content.contains("停止")) {
      stopVisible = true
    }
    if depth < 14 {
      queue.append(contentsOf: children(element).map { ($0, depth + 1) })
    }
  }
  return (texts, stopVisible, webAreas, webCharacters)
}

func sendPaste(_ message: String, window: AXUIElement) -> Bool {
  let pasteboard = NSPasteboard.general
  let previous = pasteboard.string(forType: .string)
  pasteboard.clearContents()
  guard pasteboard.setString(message, forType: .string) else { return false }

  // The prepared ChatGPT tab is frontmost. A click near the bottom-center of
  // that window focuses its composer without opening or switching tabs.
  var positionRef: CFTypeRef?
  var sizeRef: CFTypeRef?
  _ = AXUIElementCopyAttributeValue(window, kAXPositionAttribute as CFString, &positionRef)
  _ = AXUIElementCopyAttributeValue(window, kAXSizeAttribute as CFString, &sizeRef)
  var position = CGPoint(x: 0, y: 0)
  var size = CGSize(width: 1366, height: 768)
  if let p = positionRef, AXValueGetValue(p as! AXValue, .cgPoint, &position) {}
  if let s = sizeRef, AXValueGetValue(s as! AXValue, .cgSize, &size) {}
  let point = CGPoint(x: position.x + size.width / 2, y: position.y + size.height - 70)
  let source = CGEventSource(stateID: .combinedSessionState)
  let click = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left)
  click?.post(tap: .cghidEventTap)
  let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)
  up?.post(tap: .cghidEventTap)
  usleep(100_000)
  let commandV = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: true)
  commandV?.flags = .maskCommand
  commandV?.post(tap: .cghidEventTap)
  let commandVUp = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: false)
  commandVUp?.flags = .maskCommand
  commandVUp?.post(tap: .cghidEventTap)
  usleep(50_000)
  let enter = CGEvent(keyboardEventSource: source, virtualKey: 36, keyDown: true)
  enter?.post(tap: .cghidEventTap)
  let enterUp = CGEvent(keyboardEventSource: source, virtualKey: 36, keyDown: false)
  enterUp?.post(tap: .cghidEventTap)

  // Paste is delivered asynchronously by the browser. Restore the user's
  // clipboard only after the paste and Enter events have been consumed; doing
  // it immediately can race and paste the old clipboard value instead.
  usleep(500_000)

  // Restore the previous text clipboard after the interaction. This helper
  // never closes Chrome or changes the selected conversation.
  if let previous {
    pasteboard.clearContents()
    _ = pasteboard.setString(previous, forType: .string)
  }
  return true
}

guard let input = String(data: FileHandle.standardInput.readDataToEndOfFile(), encoding: .utf8),
      let request = try? JSONDecoder().decode(Request.self, from: Data(input.utf8)) else {
  emit(Response(ok: false, reply: nil, errorCode: "INVALID_REQUEST", error: "stdin must contain JSON request", diagnostics: nil))
  exit(2)
}

guard let window = frontChromeWindow() else {
  emit(Response(ok: false, reply: nil, errorCode: "CHROME_NOT_FRONTMOST", error: "active Chrome window was not found", diagnostics: nil))
  exit(1)
}

guard sendPaste(request.message, window: window) else {
  emit(Response(ok: false, reply: nil, errorCode: "SEND_FAILED", error: "could not write clipboard", diagnostics: nil))
  exit(1)
}

let deadline = Date().addingTimeInterval(Double(max(1, request.timeout_ms)) / 1000.0)
var last = ""
var stable = 0
while Date() < deadline {
  let state = snapshot(window: window)
  guard let identityIndex = state.texts.lastIndex(where: { $0.contains(request.identity) }) else {
    usleep(250_000)
    continue
  }
  let reply = state.texts.dropFirst(identityIndex + 1).joined(separator: "\n")
  if reply == last { stable += 1 } else { last = reply; stable = 0 }
  if reply.contains(request.closing_marker) && stable >= 2 && !state.stopVisible {
    emit(Response(ok: true, reply: reply, errorCode: nil, error: nil, diagnostics: nil))
    exit(0)
  }
  usleep(250_000)
}

let finalState = snapshot(window: window)
let hasIdentity = finalState.texts.contains(where: { $0.contains(request.identity) })
let pageTextUnavailable = finalState.webAreas > 0 && finalState.webCharacters == 0
emit(Response(
  ok: false,
  reply: nil,
  errorCode: pageTextUnavailable || hasIdentity ? "AX_PAGE_TEXT_UNAVAILABLE" : "REPLY_READ_FAILED",
  error: pageTextUnavailable || hasIdentity ? "Chrome AXWebArea exposes no readable page text" : "correlated assistant response was not found",
  diagnostics: ["ax_text_nodes": String(finalState.texts.count), "web_area_count": String(finalState.webAreas), "web_character_count": String(finalState.webCharacters), "stop_visible": String(finalState.stopVisible)]
))
exit(1)
