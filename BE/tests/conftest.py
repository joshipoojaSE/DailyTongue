import sys
from pathlib import Path

# The backend's modules live in BE/, one level up.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
