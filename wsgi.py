"""Production entry point for gunicorn / waitress:
       gunicorn -w 4 -b 0.0.0.0:8000 wsgi:app          (Linux)
       waitress-serve --port=8000 wsgi:app             (Windows)
"""
from app import create_app
from app.config import ProductionConfig

app = create_app(ProductionConfig)
