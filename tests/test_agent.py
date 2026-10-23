import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('relay_agent', Path(__file__).resolve().parents[1] / 'agent/agent.py')
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)


class FilesSafety(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / 'home'; self.root.mkdir()
        (self.root / 'notes.txt').write_bytes(b'personal notes\n')
        (self.root / 'Documents').mkdir()
        (self.root / '.ssh').mkdir(); (self.root / '.ssh/key').write_text('private')
        (self.root / '.env').write_text('secret')
        (self.root / 'client.key').write_text('secret')
        (self.root / 'escape').symlink_to(Path(self.tmp.name), target_is_directory=True)
        (self.root / 'link.txt').symlink_to(self.root / 'notes.txt')
        self.config = {'file_roots': {'home': {'path': str(self.root), 'name': 'Home'}}}

    def tearDown(self): self.tmp.cleanup()

    def request(self, path='', action='list', output=None):
        return agent.file_request(self.config, {'root': 'home', 'path': path, 'action': action}, output=output)

    def test_listing_hides_credentials_and_sorts_folders(self):
        result = self.request()
        self.assertEqual(result['entries'][0]['name'], 'Documents')
        self.assertFalse({'.ssh', '.env', 'client.key'} & {e['name'] for e in result['entries']})

    def test_parent_absolute_and_hidden_paths_are_rejected(self):
        for path in ['../', '../outside', '/etc/passwd', '.ssh/key', 'Documents/../notes.txt', 'client.key', 'a\\b', 'a\0b']:
            with self.subTest(path=path), self.assertRaises(agent.FileError): self.request(path)

    def test_directory_and_file_symlinks_are_never_followed(self):
        with self.assertRaises(OSError): self.request('escape')
        with self.assertRaises(OSError): self.request('link.txt', 'download', io.BytesIO())

    def test_regular_file_download_is_exact(self):
        target = io.BytesIO(); self.request('notes.txt', 'download', target)
        header, data = target.getvalue().split(b'\n', 1)
        self.assertEqual(json.loads(header)['size'], len(data))
        self.assertEqual(data, b'personal notes\n')

    def test_fifo_is_not_downloaded(self):
        os.mkfifo(self.root / 'pipe')
        with self.assertRaises(agent.FileError): self.request('pipe', 'download', io.BytesIO())

    def test_unknown_root_is_denied(self):
        with self.assertRaises(agent.FileError): agent.file_request(self.config, {'root': 'system', 'path': ''})


if __name__ == '__main__': unittest.main()
