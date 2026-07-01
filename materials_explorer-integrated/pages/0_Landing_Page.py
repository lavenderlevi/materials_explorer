"""
Landing Page — Materials Explorer
Renders the React-equivalent landing page (MaterialsExplorerLanding.jsx)
as a full-screen HTML component inside Streamlit.
"""

from __future__ import annotations
from pathlib import Path
import streamlit as st
import streamlit.components.v1 as components

st.set_page_config(
    page_title="Materials Explorer — Home",
    page_icon="⚗️",
    layout="wide",
    initial_sidebar_state="collapsed",
)

# Hide Streamlit chrome so the landing page fills the viewport cleanly.
st.markdown(
    """
    <style>
        #MainMenu { visibility: hidden; }
        header    { visibility: hidden; }
        footer    { visibility: hidden; }
        /* Remove default padding that Streamlit adds */
        .block-container { padding: 0 !important; max-width: 100% !important; }
        [data-testid="stAppViewContainer"] { padding: 0; }
        [data-testid="stVerticalBlock"]    { gap: 0; }
    </style>
    """,
    unsafe_allow_html=True,
)

# Load the compiled HTML landing page.
html_path = Path(__file__).parent.parent / "landing.html"

if not html_path.exists():
    st.error(
        f"landing.html not found at `{html_path}`. "
        "Make sure the file is in the project root alongside `app.py`."
    )
    st.stop()

html_content = html_path.read_text(encoding="utf-8")

# Inject a link that lets the landing page CTA navigate to the main Streamlit app.
# The href="#" buttons in the HTML can be replaced here if needed.
# For now we render the full page; height is set tall enough for all sections.
components.html(
    html_content,
    height=5500,   # generous height — adjusts to content via scrolling
    scrolling=True,
)
