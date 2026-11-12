"""Read one owned result section through pre-existing native UIA COM bindings.

Run with the existing interpreter that already contains the generated
comtypes.gen.UIAutomationClient module. No server, binding generation, input,
focus, clipboard, task invocation, file output or window closing is performed.
"""

import argparse
import ctypes
from ctypes import wintypes
import json
import sys

sys.dont_write_bytecode = True
sys.coinit_flags = 0  # UIA client calls use a dedicated multithreaded apartment.

import comtypes
from comtypes.gen import UIAutomationClient as uia


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pid", type=int, required=True)
    parser.add_argument("--creation-file-time", type=int, required=True)
    parser.add_argument("--window-handle", type=int, required=True)
    value = parser.parse_args()
    require(value.pid > 0 and value.creation_file_time > 0 and value.window_handle > 0,
            "Exact positive process and window identities are required.")
    return value


class OwnedWindow:
    def __init__(self, expected):
        self.expected = expected
        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        self.user = ctypes.WinDLL("user32", use_last_error=True)
        self.kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        self.kernel.OpenProcess.restype = wintypes.HANDLE
        self.kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        self.kernel.CloseHandle.restype = wintypes.BOOL
        self.kernel.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
        self.kernel.GetProcessTimes.restype = wintypes.BOOL
        self.user.IsWindow.argtypes = [wintypes.HWND]
        self.user.IsWindow.restype = wintypes.BOOL
        self.user.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
        self.user.GetWindowThreadProcessId.restype = wintypes.DWORD
        self.handle = self.kernel.OpenProcess(0x1000, False, expected.pid)
        if not self.handle:
            raise ctypes.WinError(ctypes.get_last_error())

    def verify(self, element=None):
        times = [wintypes.FILETIME() for _ in range(4)]
        if not self.kernel.GetProcessTimes(self.handle, *(ctypes.byref(value) for value in times)):
            raise ctypes.WinError(ctypes.get_last_error())
        created = (times[0].dwHighDateTime << 32) | times[0].dwLowDateTime
        require(created == self.expected.creation_file_time, "Owned process creation identity changed.")
        require(self.user.IsWindow(self.expected.window_handle), "Owned window no longer exists.")
        process_id = wintypes.DWORD()
        self.user.GetWindowThreadProcessId(self.expected.window_handle, ctypes.byref(process_id))
        require(process_id.value == self.expected.pid, "Owned HWND process identity changed.")
        if element is not None:
            require(element.CurrentProcessId == self.expected.pid, "Native UIA root process identity changed.")
            require((element.CurrentNativeWindowHandle & 0xFFFFFFFF) == (self.expected.window_handle & 0xFFFFFFFF),
                    "Native UIA root HWND identity changed.")

    def close(self):
        if self.handle:
            self.kernel.CloseHandle(self.handle)
            self.handle = None


def elements(parent, condition):
    found = parent.FindAll(uia.TreeScope_Descendants, condition)
    require(found.Length <= 256, "Unexpected native result-section size.")
    return [found.GetElement(index) for index in range(found.Length)]


def name(element):
    value = element.CurrentName or ""
    require(isinstance(value, str) and len(value) <= 32768, "Native element name is not bounded text.")
    return value


def property_value(automation, element, identifier):
    # Official GetCurrentPropertyValueEx preserves the native NotSupported
    # identifier. CheckNotSupported checks that actual VARIANT, not its spelling.
    # https://learn.microsoft.com/windows/win32/api/uiautomationclient/nf-uiautomationclient-iuiautomation-checknotsupported
    value = element.GetCurrentPropertyValueEx(identifier, True)
    if automation.CheckNotSupported(value):
        return {"supported": False}
    if identifier == uia.UIA_AriaRolePropertyId:
        require(isinstance(value, str), "Native ARIA role is not text.")
        # Compare two real native getters, including the official CurrentAriaRole.
        direct = element.CurrentAriaRole or ""
        require(direct == value, "Native ARIA-role getters disagree.")
        require(len(value) <= 256, "Unexpected native ARIA-role length.")
    else:
        require(type(value) is int and value in (0, 1, 2), "Unexpected native LiveSetting value.")
    return {"supported": True, "value": value}


def observe(expected):
    owned = OwnedWindow(expected)
    try:
        owned.verify()
        automation = comtypes.CoCreateInstance(uia.CUIAutomation8._reg_clsid_,
                                               interface=uia.IUIAutomation,
                                               clsctx=comtypes.CLSCTX_INPROC_SERVER)
        root = automation.ElementFromHandle(expected.window_handle)
        owned.verify(root)
        named_scope = automation.CreatePropertyCondition(uia.UIA_NamePropertyId, "结果文件")
        button_condition = automation.CreatePropertyCondition(uia.UIA_ControlTypePropertyId, uia.UIA_ButtonControlTypeId)
        scopes = [scope for scope in elements(root, named_scope)
                  if sum(name(button) == "重新核对位置" for button in elements(scope, button_condition)) == 1]
        if len(scopes) != 1:
            return {"ready": False, "scopeMatches": len(scopes), "observer": "native-uia-com"}
        scope = scopes[0]
        descendants = elements(scope, automation.CreateTrueCondition())
        names = list(dict.fromkeys(value for element in descendants if (value := name(element))))
        require(len(names) <= 200, "Unexpected native result-section name count.")
        buttons = [{"name": name(element), "enabled": bool(element.CurrentIsEnabled),
                    "offscreen": bool(element.CurrentIsOffscreen)}
                   for element in descendants if element.CurrentControlType == uia.UIA_ButtonControlTypeId]
        properties = []
        alerts = []
        for element in descendants:
            aria = property_value(automation, element, uia.UIA_AriaRolePropertyId)
            live = property_value(automation, element, uia.UIA_LiveSettingPropertyId)
            properties.append({"name": name(element), "ariaRole": aria, "liveSetting": live})
            if aria.get("supported") and "alert" in aria["value"].split():
                region_names = [name(element)] + [name(child) for child in elements(element, automation.CreateTrueCondition())]
                message = "\n".join(dict.fromkeys(value for value in region_names if value))
                require(0 < len(message) <= 32768, "Native alert region has no bounded readable content.")
                alerts.append(message)
        supported = sum(value["ariaRole"]["supported"] for value in properties)
        require(supported > 0, "The native provider did not expose ARIA roles. Error absence remains unverified.")
        owned.verify(root)
        return {"ready": True, "names": names, "buttons": buttons, "text": "", "alerts": alerts,
                "alertObservation": {"observer": "native-uia-com", "property": "IUIAutomationElement.CurrentAriaRole",
                                     "propertyId": uia.UIA_AriaRolePropertyId, "supportedElements": supported,
                                     "unsupportedElements": len(properties) - supported,
                                     "assertiveRegions": sum(value["liveSetting"].get("value") == 2 for value in properties),
                                     "properties": properties, "focusChanged": False, "inputSent": False}}
    finally:
        owned.close()


if __name__ == "__main__":
    try:
        print(json.dumps(observe(arguments()), ensure_ascii=True, separators=(",", ":")))
    except Exception as error:
        print(json.dumps({"ready": False, "observer": "native-uia-com", "errorType": type(error).__name__,
                          "error": str(error)[:1600]}, ensure_ascii=True), file=sys.stderr)
        raise SystemExit(1)
