"""Native login Keychain adapter; real reads are for the worker/owner only.

No security CLI password arguments or plaintext credential files. Tests use
synthetic items in a separate service namespace; agents never read the live item.
"""
import ctypes as c
import json
import sys
from common import validated_tokens

SERVICE = b'com.moriyan.thread-watch.slack'
ACCOUNT = b'configured-installation'

class Keychain:
    def __init__(self, interactive=False, service=SERVICE, account=ACCOUNT):
        if sys.platform != 'darwin': raise ValueError('platform')
        self.service, self.account = service, account
        self.security = c.CDLL('/System/Library/Frameworks/Security.framework/Security')
        self.core = c.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
        signatures = {
            'SecKeychainSetUserInteractionAllowed': [c.c_ubyte],
            'SecKeychainCopyLogin': [c.POINTER(c.c_void_p)],
            'SecKeychainGetStatus': [c.c_void_p, c.POINTER(c.c_uint32)],
            'SecKeychainUnlock': [c.c_void_p, c.c_uint32, c.c_void_p, c.c_ubyte],
            'SecKeychainAddGenericPassword': [c.c_void_p, c.c_uint32, c.c_char_p, c.c_uint32, c.c_char_p, c.c_uint32, c.c_void_p, c.POINTER(c.c_void_p)],
            'SecKeychainFindGenericPassword': [c.c_void_p, c.c_uint32, c.c_char_p, c.c_uint32, c.c_char_p, c.POINTER(c.c_uint32), c.POINTER(c.c_void_p), c.POINTER(c.c_void_p)],
            'SecKeychainItemModifyAttributesAndData': [c.c_void_p, c.c_void_p, c.c_uint32, c.c_void_p],
            'SecKeychainItemFreeContent': [c.c_void_p, c.c_void_p],
            'SecKeychainItemDelete': [c.c_void_p],
        }
        for name, arguments in signatures.items():
            function = getattr(self.security, name); function.argtypes = arguments; function.restype = c.c_int32
        self.core.CFRelease.argtypes = [c.c_void_p]; self.core.CFRelease.restype = None
        self.check(self.security.SecKeychainSetUserInteractionAllowed(bool(interactive)))
        self.login = c.c_void_p()
        self.check(self.security.SecKeychainCopyLogin(c.byref(self.login)))

    @staticmethod
    def check(status):
        if status: raise ValueError('keychain_unavailable')

    def find(self, length=None, data=None, item=None):
        return self.security.SecKeychainFindGenericPassword(self.login, len(self.service), self.service,
            len(self.account), self.account, length, data, item)

    def exists(self) -> bool:
        # NULL data and length pointers request metadata only, never a password.
        status = self.find()
        if status == -25300: return False
        self.check(status); return True

    def unlocked(self) -> bool:
        flags = c.c_uint32()
        self.check(self.security.SecKeychainGetStatus(self.login, c.byref(flags)))
        return bool(flags.value & 1)

    def unlock(self, password: str) -> None:
        # Owner-private hidden input only. Never use security -p arguments.
        payload = password.encode(); buffer = c.create_string_buffer(payload)
        try: self.check(self.security.SecKeychainUnlock(self.login, len(payload), buffer, True))
        finally: c.memset(buffer, 0, len(buffer))

    def store(self, values: dict[str, str]) -> None:
        payload = json.dumps(validated_tokens(values), separators=(',', ':')).encode()
        buffer = c.create_string_buffer(payload)
        status = self.security.SecKeychainAddGenericPassword(self.login, len(self.service), self.service,
            len(self.account), self.account, len(payload), buffer, None)
        if status != -25299: self.check(status); return
        item = c.c_void_p()
        self.check(self.find(item=c.byref(item)))
        try: self.check(self.security.SecKeychainItemModifyAttributesAndData(item, None, len(payload), buffer))
        finally: self.core.CFRelease(item)

    def read(self) -> dict[str, str]:
        length = c.c_uint32(); data = c.c_void_p()
        self.check(self.find(c.byref(length), c.byref(data)))
        try:
            if length.value > 16384: raise ValueError('credentials')
            return validated_tokens(json.loads(c.string_at(data, length.value)))
        finally: self.check(self.security.SecKeychainItemFreeContent(None, data))

    def delete_test_item(self) -> None:
        if not self.service.startswith(b'com.moriyan.thread-watch.test.'):
            raise ValueError('not_test_item')
        item = c.c_void_p(); self.check(self.find(item=c.byref(item)))
        try: self.check(self.security.SecKeychainItemDelete(item))
        finally: self.core.CFRelease(item)
