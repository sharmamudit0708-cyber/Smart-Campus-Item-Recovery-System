
import os
import re
import uuid
import secrets
import hashlib
import smtplib
from email.message import EmailMessage
from datetime import date, datetime, timezone, timedelta
from pathlib import Path
from functools import wraps

from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request, session, send_from_directory
from flask_login import (
    LoginManager, UserMixin, current_user, login_required,
    login_user, logout_user
)
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import or_
from werkzeug.security import check_password_hash, generate_password_hash
from werkzeug.utils import secure_filename

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent
UPLOAD_DIR = BASE_DIR / "static" / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

app = Flask(
    __name__,
    template_folder="templates",
    static_folder="static"
)

secret = os.getenv("SECRET_KEY")
if not secret or secret == "replace-this-with-a-long-random-secret":
    raise RuntimeError("Set a private SECRET_KEY in your .env file.")

app.config["SECRET_KEY"] = secret
app.config["SQLALCHEMY_DATABASE_URI"] = (
    "sqlite:///" + (BASE_DIR / "campus.db").as_posix()
)
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
app.config["MAX_CONTENT_LENGTH"] = 5 * 1024 * 1024
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
app.config["SESSION_COOKIE_SECURE"] = False  # Local HTTP development only
app.config["PERMANENT_SESSION_LIFETIME"] = timedelta(minutes=30)

db = SQLAlchemy(app)
login_manager = LoginManager(app)

ADMIN_EMAIL = os.getenv("ADMIN_EMAIL", "").strip().lower()
ALLOWED_IMAGE_EXTENSIONS = {"png", "jpg", "jpeg", "webp"}


def utc_now():
    return datetime.now(timezone.utc).replace(tzinfo=None)


class User(UserMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(80), nullable=False)
    email = db.Column(db.String(254), unique=True, nullable=False, index=True)
    password_hash = db.Column(db.String(255), nullable=False)
    role = db.Column(db.String(20), default="student", nullable=False)
    created_at = db.Column(db.DateTime, default=utc_now, nullable=False)


class Item(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    type = db.Column(db.String(10), nullable=False)  # lost / found
    name = db.Column(db.String(120), nullable=False)
    category = db.Column(db.String(60), nullable=False)
    location = db.Column(db.String(200), nullable=False)
    item_date = db.Column(db.Date, nullable=False)
    contact = db.Column(db.String(254), nullable=False)
    description = db.Column(db.String(2000), nullable=False)
    image = db.Column(db.String(255), default="")
    status = db.Column(db.String(20), default="active", nullable=False)
    reporter_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False)
    created_at = db.Column(db.DateTime, default=utc_now, nullable=False)

    reporter = db.relationship("User", foreign_keys=[reporter_id])


class Claim(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    item_id = db.Column(db.Integer, db.ForeignKey("item.id"), nullable=False)
    claimer_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False)
    reason = db.Column(db.String(2000), nullable=False)
    proof = db.Column(db.String(500), default="")
    status = db.Column(db.String(20), default="pending", nullable=False)
    created_at = db.Column(db.DateTime, default=utc_now, nullable=False)

    item = db.relationship("Item")
    claimer = db.relationship("User")


class Notification(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False)
    message = db.Column(db.String(500), nullable=False)
    created_at = db.Column(db.DateTime, default=utc_now, nullable=False)


@login_manager.user_loader
def load_user(user_id):
    return db.session.get(User, int(user_id))


@login_manager.unauthorized_handler
def unauthorized():
    return jsonify({"error": "Please log in first."}), 401


def error(message, status=400):
    return jsonify({"error": message}), status


def admin_required(fn):
    @wraps(fn)
    @login_required
    def wrapped(*args, **kwargs):
        if current_user.role != "admin":
            return error("Administrator access required.", 403)
        return fn(*args, **kwargs)
    return wrapped


def notify(user_id, message):
    db.session.add(Notification(user_id=user_id, message=message))


def user_json(user):
    return {
        "id": user.id,
        "name": user.name,
        "email": user.email,
        "role": user.role
    }


def item_json(item):
    return {
        "id": item.id,
        "type": item.type,
        "name": item.name,
        "category": item.category,
        "location": item.location,
        "date": item.item_date.isoformat(),
        "contact": item.contact,
        "description": item.description,
        "image": item.image,
        "reporter": item.reporter.name,
        "reporter_id": item.reporter_id,
        "status": item.status,
        "created_at": item.created_at.isoformat()
    }


def claim_json(claim):
    return {
        "id": claim.id,
        "itemID": claim.item_id,
        "itemName": claim.item.name,
        "claimer": claim.claimer.name,
        "claimer_id": claim.claimer_id,
        "reason": claim.reason,
        "proof": claim.proof,
        "status": claim.status,
        "created_at": claim.created_at.isoformat()
    }


def notification_json(note):
    return {
        "id": note.id,
        "message": note.message,
        "time": note.created_at.isoformat()
    }


def match_score(a, b):
    """Simple, explainable lost/found matching score."""
    score = 0

    if a.category.lower() == b.category.lower():
        score += 2

    if a.location.strip().casefold() == b.location.strip().casefold():
        score += 2

    words_a = set(re.findall(r"[a-z0-9]+",
                            f"{a.name} {a.description}".lower()))
    words_b = set(re.findall(r"[a-z0-9]+",
                            f"{b.name} {b.description}".lower()))
    words_a = {w for w in words_a if len(w) > 2}
    words_b = {w for w in words_b if len(w) > 2}
    score += min(len(words_a & words_b), 5)

    if a.item_date == b.item_date:
        score += 1

    return score


def find_matches(item):
    others = Item.query.filter(
        Item.id != item.id,
        Item.type != item.type,
        Item.status == "active"
    ).all()

    results = [
        (other, match_score(item, other))
        for other in others
    ]
    results = [(other, score) for other, score in results if score >= 2]
    results.sort(key=lambda pair: pair[1], reverse=True)

    return [
        {"item": item_json(other), "score": score}
        for other, score in results[:10]
    ]


@app.get("/")
def home():
    return render_template("index.html")

@app.get("/admin")
@login_required
def admin_dashboard():
    if current_user.role != "admin":
        return "Administrator access required.", 403

    return render_template("admin.html")

@app.get("/api/health")
def health():
    return jsonify({"status": "ok", "message": "Backend is running"})


# ---------- Password-based registration and login ----------
@app.post("/api/register")
def register():
    data = request.get_json(silent=True) or {}
    name = str(data.get("name", "")).strip()
    email = str(data.get("email", "")).strip().lower()
    password = str(data.get("password", ""))

    if not name or len(name) > 80:
        return error("Enter your name (1–80 characters).")
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        return error("Enter a valid email address.")
    if len(password) < 8:
        return error("Password must be at least 8 characters.")
    if User.query.filter_by(email=email).first():
        return error("This email is already registered. Please log in.", 409)

    user = User(
        name=name,
        email=email,
        password_hash=generate_password_hash(password),
        role="admin" if ADMIN_EMAIL and email == ADMIN_EMAIL else "student"
    )
    db.session.add(user)
    db.session.flush()
    notify(user.id, f"Welcome {user.name}! Your account has been created.")
    db.session.commit()
    login_user(user)
    return jsonify({"message": "Account created successfully.", "user": user_json(user)}), 201


@app.post("/api/login")
def login():
    data = request.get_json(silent=True) or {}
    email = str(data.get("email", "")).strip().lower()
    password = str(data.get("password", ""))

    if not email or not password:
        return error("Enter your email and password.")
    user = User.query.filter_by(email=email).first()
    if not user or not check_password_hash(user.password_hash, password):
        return error("Incorrect email or password.", 401)

    login_user(user)
    return jsonify({"message": "Login successful.", "user": user_json(user)})


@app.post("/api/logout")
@login_required
def logout():
    logout_user()
    return jsonify({"message": "Logged out successfully."})


@app.get("/api/me")
def me():
    if not current_user.is_authenticated:
        return jsonify({"user": None})
    return jsonify({"user": user_json(current_user)})


# ---------- Item reports ----------

@app.get("/api/items")
def get_items():
    query = Item.query

    item_type = request.args.get("type", "all").lower()
    search = request.args.get("search", "").strip()

    if item_type in {"lost", "found"}:
        query = query.filter_by(type=item_type)

    if search:
        pattern = f"%{search}%"
        query = query.filter(or_(
            Item.name.ilike(pattern),
            Item.category.ilike(pattern),
            Item.location.ilike(pattern),
            Item.description.ilike(pattern)
        ))

    items = query.order_by(Item.created_at.desc()).all()
    return jsonify({"items": [item_json(i) for i in items]})


@app.post("/api/items")
@login_required
def create_item():
    data = request.form if request.form else (request.get_json(silent=True) or {})

    item_type = str(data.get("type", "")).strip().lower()
    name = str(data.get("name", "")).strip()
    category = str(data.get("category", "")).strip()
    location = str(data.get("location", "")).strip()
    contact = str(data.get("contact", "")).strip()
    description = str(data.get("description", "")).strip()
    raw_date = str(data.get("date", "")).strip()

    if item_type not in {"lost", "found"}:
        return error("Report type must be lost or found.")
    if not name or len(name) > 120:
        return error("Item name is required and must be under 120 characters.")
    if not category or len(category) > 60:
        return error("Select a valid category.")
    if not location or len(location) > 200:
        return error("Location is required and must be under 200 characters.")
    if not contact or len(contact) > 254:
        return error("Contact information is required.")
    if not description or len(description) > 2000:
        return error("Description is required and must be under 2000 characters.")

    try:
        item_date = date.fromisoformat(raw_date)
    except ValueError:
        return error("Enter a valid item date.")

    image_path = ""
    file = request.files.get("image")

    if file and file.filename:
        safe_name = secure_filename(file.filename)
        extension = safe_name.rsplit(".", 1)[-1].lower() if "." in safe_name else ""

        if extension not in ALLOWED_IMAGE_EXTENSIONS:
            return error("Images must be PNG, JPG, JPEG, or WEBP.")
        if not file.mimetype or not file.mimetype.startswith("image/"):
            return error("Uploaded file must be an image.")

        filename = f"{uuid.uuid4().hex}.{extension}"
        file.save(UPLOAD_DIR / filename)
        image_path = f"/static/uploads/{filename}"

    item = Item(
        type=item_type,
        name=name,
        category=category,
        location=location,
        item_date=item_date,
        contact=contact,
        description=description,
        image=image_path,
        reporter_id=current_user.id
    )
    db.session.add(item)
    db.session.flush()

    notify(current_user.id, f"Your {item_type} report '{name}' was created.")
    matches = find_matches(item)

    for match in matches:
        other = db.session.get(Item, match["item"]["id"])
        if other and other.reporter_id != current_user.id:
            notify(
                other.reporter_id,
                f"Possible match found for your item '{other.name}'."
            )
        notify(
            current_user.id,
            f"Possible match found for '{name}' with '{other.name}'."
        )

    db.session.commit()

    return jsonify({
        "item": item_json(item),
        "matches": matches
    }), 201


# ---------- Claims and administrator decisions ----------

@app.get("/api/claims")
@login_required
def get_claims():
    query = Claim.query.order_by(Claim.created_at.desc())

    if current_user.role != "admin":
        query = query.filter_by(claimer_id=current_user.id)

    claims = query.all()
    return jsonify({"claims": [claim_json(c) for c in claims]})

@app.get("/api/admin/data")
@admin_required
def admin_data():
    users = User.query.order_by(User.created_at.desc()).all()
    items = Item.query.order_by(Item.created_at.desc()).all()
    claims = Claim.query.order_by(Claim.created_at.desc()).all()

    return jsonify({
        "stats": {
            "total_users": User.query.count(),
            "total_items": Item.query.count(),
            "lost_items": Item.query.filter_by(type="lost").count(),
            "found_items": Item.query.filter_by(type="found").count(),
            "pending_claims": Claim.query.filter_by(
                status="pending"
            ).count()
        },

        "users": [
            {
                "id": user.id,
                "name": user.name,
                "email": user.email,
                "role": user.role
            }
            for user in users
        ],

        "items": [item_json(item) for item in items],

        "claims": [claim_json(claim) for claim in claims]
    })

@app.post("/api/claims")
@login_required
def create_claim():
    data = request.get_json(silent=True) or {}

    try:
        item_id = int(data.get("itemID"))
    except (TypeError, ValueError):
        return error("Select a valid item.")

    reason = str(data.get("reason", "")).strip()
    proof = str(data.get("proof", "")).strip()

    if not reason or len(reason) > 2000:
        return error("Ownership explanation is required.")
    if len(proof) > 500:
        return error("Verification detail is too long.")

    item = db.session.get(Item, item_id)
    if not item or item.type != "found" or item.status != "active":
        return error("This item is not available to claim.", 404)
    if item.reporter_id == current_user.id:
        return error("You cannot claim an item you reported yourself.")
    if Claim.query.filter_by(
        item_id=item.id, claimer_id=current_user.id, status="pending"
    ).first():
        return error("You already have a pending claim for this item.", 409)

    claim = Claim(
        item_id=item.id,
        claimer_id=current_user.id,
        reason=reason,
        proof=proof
    )
    db.session.add(claim)
    db.session.flush()

    notify(current_user.id, f"Your claim for '{item.name}' is pending review.")
    notify(item.reporter_id, f"A claim has been submitted for '{item.name}'.")
    db.session.commit()

    return jsonify({"claim": claim_json(claim)}), 201


@app.post("/api/claims/<int:claim_id>/decision")
@admin_required
def decide_claim(claim_id):
    data = request.get_json(silent=True) or {}
    decision = str(data.get("decision", "")).strip().lower()

    if decision not in {"approved", "rejected"}:
        return error("Decision must be approved or rejected.")

    claim = db.session.get(Claim, claim_id)
    if not claim:
        return error("Claim not found.", 404)
    if claim.status != "pending":
        return error("This claim has already been reviewed.", 409)

    item = db.session.get(Item, claim.item_id)

    if decision == "approved":
        if item.status != "active":
            return error("This item is no longer available.", 409)

        claim.status = "approved"
        item.status = "returned"
        notify(claim.claimer_id, f"Your claim for '{item.name}' was approved.")
        notify(item.reporter_id, f"'{item.name}' has been marked as returned.")
    else:
        claim.status = "rejected"
        notify(claim.claimer_id, f"Your claim for '{item.name}' was rejected.")

    db.session.commit()
    return jsonify({"claim": claim_json(claim), "item": item_json(item)})


# ---------- Notifications and statistics ----------

@app.get("/api/notifications")
@login_required
def get_notifications():
    notes = Notification.query.filter_by(
        user_id=current_user.id
    ).order_by(Notification.created_at.desc()).limit(50).all()

    return jsonify({"notifications": [notification_json(n) for n in notes]})


@app.delete("/api/notifications")
@login_required
def clear_notifications():
    Notification.query.filter_by(user_id=current_user.id).delete()
    db.session.commit()
    return jsonify({"message": "Notifications cleared."})


@app.get("/api/stats")
def stats():
    return jsonify({
        "total": Item.query.count(),
        "lost": Item.query.filter_by(type="lost", status="active").count(),
        "found": Item.query.filter_by(type="found", status="active").count(),
        "returned": Item.query.filter_by(status="returned").count()
    })


@app.errorhandler(413)
def too_large(_error):
    return jsonify({"error": "Upload is too large. Maximum size is 5 MB."}), 413


@app.errorhandler(404)
def not_found(_error):
    if request.path.startswith("/api/"):
        return jsonify({"error": "API endpoint not found."}), 404
    return "Page not found", 404


with app.app_context():
    db.create_all()


if __name__ == "__main__":
    app.run(debug=True)
