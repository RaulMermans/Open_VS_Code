import unittest
from src.clamp import clamp

class ClampTest(unittest.TestCase):
    def test_inside(self):
        self.assertEqual(clamp(5, 0, 10), 5)

    def test_low(self):
        self.assertEqual(clamp(-1, 0, 10), 0)

    def test_high(self):
        self.assertEqual(clamp(99, 0, 10), 10)

if __name__ == "__main__":
    unittest.main()
