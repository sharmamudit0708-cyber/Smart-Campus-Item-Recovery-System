/* =====================================================
   SMART CAMPUS ITEM RECOVERY SYSTEM
   ===================================================== */


/* ================= DATABASE ================= */

let database =
    JSON.parse(localStorage.getItem("smartCampusDatabase"))
    || {

        user: null,

        items: [],

        claims: [],

        notifications: []

    };

// Do not trust a saved browser login. The Flask session is the source of truth.
database.user = null;


/* ================= SAVE DATABASE ================= */

function saveDatabase() {

    localStorage.setItem(
        "smartCampusDatabase",
        JSON.stringify(database)
    );

    displayAll();

}


/* ================= ID GENERATOR ================= */

function generateID(prefix) {

    return prefix +
        Date.now() +
        Math.random()
            .toString(16)
            .slice(2);

}


/* ================= TOAST ================= */

function showToast(message) {

    const toast =
        document.getElementById("toast");

    toast.innerText = message;

    toast.classList.add("show");

    setTimeout(() => {

        toast.classList.remove("show");

    }, 2500);

}


/* =====================================================
   LOGIN / REGISTER
   ===================================================== */

function openLogin() {
    document.getElementById("loginModal").style.display = "flex";
    updateAuthMode();
}

function closeLogin() {
    document.getElementById("loginModal").style.display = "none";
}

function updateAuthMode() {
    const mode = document.getElementById("authMode").value;
    document.getElementById("authNameGroup").style.display = mode === "register" ? "block" : "none";
    document.getElementById("loginPassword").autocomplete = mode === "register" ? "new-password" : "current-password";
    document.getElementById("authSubmitButton").innerText = mode === "register" ? "Create Account" : "Login";
}

async function apiRequest(url, data = {}) {
    const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(data)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Something went wrong. Please try again.");
    return result;
}

async function loginUser() {
    const mode = document.getElementById("authMode").value;
    const name = document.getElementById("loginName").value.trim();
    const email = document.getElementById("loginEmail").value.trim();
    const password = document.getElementById("loginPassword").value;

    if (!email || !password || (mode === "register" && !name)) {
        showToast(mode === "register" ? "Enter your name, email and password" : "Enter email and password");
        return;
    }
    if (password.length < 8) {
        showToast("Password must be at least 8 characters");
        return;
    }

    const button = document.getElementById("authSubmitButton");
    button.disabled = true;
    try {
        const endpoint = mode === "register" ? "/api/register" : "/api/login";
        const result = await apiRequest(endpoint, { name, email, password });
        database.user = result.user;
        saveDatabase();
        closeLogin();
        document.getElementById("loginPassword").value = "";
        showToast(result.message || (mode === "register" ? "Account created successfully" : "Login successful"));
        updateAuthButtons();
    } catch (error) {
        showToast(error.message);
    } finally {
        button.disabled = false;
    }
}

async function logoutUser() {
    try {
        await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
    } catch (error) {
        console.warn("Backend logout could not be confirmed", error);
    }
    database.user = null;
    saveDatabase();
    updateAuthButtons();
    showToast("Logged out successfully");
}

function updateAuthButtons() {
    const loggedIn = Boolean(database.user);
    document.getElementById("loginButton").style.display = loggedIn ? "none" : "inline-block";
    document.getElementById("logoutButton").style.display = loggedIn ? "inline-block" : "none";
}

/* =====================================================
   REPORT ITEM
   ===================================================== */

function openReport(type) {

    document.getElementById("reportType")
        .value = type;

    document.getElementById("report")
        .scrollIntoView({
            behavior: "smooth"
        });

}


/* ================= IMAGE PREVIEW ================= */

document.getElementById("imageInput")
    .addEventListener("change", function () {

        const file = this.files[0];

        const preview =
            document.getElementById("imagePreview");


        if (!file) {

            preview.style.display = "none";

            return;

        }


        const reader = new FileReader();


        reader.onload = function () {

            preview.src = reader.result;

            preview.style.display = "block";

        };


        reader.readAsDataURL(file);

    });


/* =====================================================
   SUBMIT ITEM
   ===================================================== */

document.getElementById("reportForm")
    .addEventListener("submit", function (event) {

        event.preventDefault();


        /* User must login */

        if (!database.user) {

            openLogin();

            showToast(
                "Please login / register first"
            );

            return;

        }


        const image =
            document.getElementById("imagePreview");


        const item = {

            id: generateID("ITEM"),

            type:
                document.getElementById("reportType")
                    .value,

            name:
                document.getElementById("itemName")
                    .value.trim(),

            category:
                document.getElementById("category")
                    .value,

            location:
                document.getElementById("location")
                    .value.trim(),

            date:
                document.getElementById("itemDate")
                    .value,

            contact:
                document.getElementById("contact")
                    .value.trim(),

            description:
                document.getElementById("description")
                    .value.trim(),

            image:
                image.style.display === "none"
                    ? ""
                    : image.src,

            reporter:
                database.user.name,

            status: "active"

        };


        /* ===============================
           STORE DATA IN DATABASE
           =============================== */

        database.items.push(item);


        database.notifications.unshift({

            id: generateID("N"),

            message:
                `${item.type === "lost"
                    ? "Lost"
                    : "Found"} item "${item.name}"
                    has been stored in database.`,

            time: new Date().toLocaleString()

        });


        /* ===============================
           SEARCH FOR MATCHING ITEMS
           =============================== */

        const matches =
            findMatches(item);


        if (matches.length > 0) {

            matches.forEach(match => {

                database.notifications.unshift({

                    id: generateID("N"),

                    message:
                        `Possible match found:
                        "${item.name}" ↔ "${match.name}"`,

                    time:
                        new Date().toLocaleString()

                });

            });

        }


        saveDatabase();


        showMatchResult(
            item,
            matches
        );


        this.reset();


        image.style.display = "none";


        if (matches.length > 0) {

            showToast(
                `${matches.length} possible match found`
            );

        } else {

            showToast(
                "Item stored. No match found"
            );

        }

    });


/* =====================================================
   MATCHING SYSTEM
   ===================================================== */

function findMatches(item) {

    const itemWords =
        getWords(item);


    return database.items
        .filter(other =>

            other.id !== item.id &&

            other.status === "active" &&

            other.type !== item.type

        )
        .map(other => {

            const otherWords =
                getWords(other);


            let score = 0;


            /* Common words */

            itemWords.forEach(word => {

                if (otherWords.includes(word)) {

                    score++;

                }

            });


            /* Same category */

            if (
                item.category ===
                other.category
            ) {

                score += 2;

            }


            /* Same location */

            if (
                item.location.toLowerCase() ===
                other.location.toLowerCase()
            ) {

                score += 2;

            }


            return {

                item: other,

                score: score

            };

        })


        .filter(result =>
            result.score >= 2
        )


        .sort(
            (a,b) =>
                b.score - a.score
        )


        .map(result =>
            result.item
        );

}


/* ================= WORD EXTRACTION ================= */

function getWords(item) {

    return (

        item.name +
        " " +
        item.category +
        " " +
        item.location +
        " " +
        item.description

    )

    .toLowerCase()

    .split(/[^a-z0-9]+/)

    .filter(word =>
        word.length > 2
    );

}


/* =====================================================
   MATCH MESSAGE
   ===================================================== */

function showMatchResult(
    item,
    matches
) {

    const box =
        document.getElementById(
            "matchMessage"
        );


    if (matches.length === 0) {

        box.innerHTML = "";

        return;

    }


    box.innerHTML = `

        <div class="match-message">

            <b>Match Found!</b>

            The system found

            ${matches.length}

            possible matching item(s)

            for

            <b>${item.name}</b>.

            Check the item list and claim
            the item if it belongs to you.

        </div>

    `;

}


/* =====================================================
   DISPLAY ITEMS
   ===================================================== */

function displayItems() {

    const grid =
        document.getElementById(
            "itemGrid"
        );


    const filter =
        document.getElementById(
            "filterType"
        ).value;


    const search =
        document.getElementById(
            "searchBox"
        ).value.toLowerCase();


    let items =
        database.items.filter(item => {

            const typeMatch =
                filter === "all" ||
                item.type === filter;


            const searchMatch = (

                item.name +
                " " +
                item.category +
                " " +
                item.location +
                " " +
                item.description

            )
            .toLowerCase()
            .includes(search);


            return typeMatch &&
                   searchMatch;

        });


    if (items.length === 0) {

        grid.innerHTML = `

            <div class="empty">

                No items found.

                <br><br>

                Report a lost or found item
                to start the recovery process.

            </div>

        `;

        return;

    }


    grid.innerHTML =
        items.reverse()
        .map(item => `

        <div class="item-card">

            <div class="item-image">

                ${
                    item.image

                    ?

                    `<img
                        src="${item.image}"
                        alt="${item.name}">
                    `

                    :

                    "No image uploaded"
                }

            </div>


            <div class="item-content">

                <div class="tags">

                    <span
                        class="tag ${item.type}">
                        ${item.type}
                    </span>

                    <span class="tag">
                        ${item.category}
                    </span>

                    ${
                        item.status === "returned"

                        ?

                        `<span class="tag">
                            Returned
                        </span>`

                        :

                        ""
                    }

                </div>


                <h3>
                    ${item.name}
                </h3>


                <p>
                    ${item.description}
                </p>


                <div class="item-bottom">

                    <small>

                        📍 ${item.location}

                        <br>

                        👤 ${item.reporter}

                    </small>


                    ${
                        item.type === "found" &&
                        item.status === "active"

                        ?

                        `<button
                            class="primary-btn"
                            onclick="openClaim('${item.id}')">

                            Claim Item

                        </button>`

                        :

                        ""
                    }

                </div>

            </div>

        </div>

    `)
    .join("");

}


/* =====================================================
   CLAIM ITEM
   ===================================================== */

function openClaim(itemID) {

    if (!database.user) {

        openLogin();

        showToast(
            "Please login to claim an item"
        );

        return;

    }


    const item =
        database.items.find(
            item => item.id === itemID
        );


    if (!item) return;


    document.getElementById(
        "claimItemId"
    ).value = itemID;


    document.getElementById(
        "claimItemName"
    ).innerText =
        "You are claiming: " +
        item.name;


    document.getElementById(
        "claimModal"
    ).style.display = "flex";

}


function closeClaim() {

    document.getElementById(
        "claimModal"
    ).style.display = "none";

}


/* =====================================================
   SUBMIT CLAIM
   ===================================================== */

function submitClaim() {

    const itemID =
        document.getElementById(
            "claimItemId"
        ).value;


    const reason =
        document.getElementById(
            "claimReason"
        ).value.trim();


    const proof =
        document.getElementById(
            "claimProof"
        ).value.trim();


    if (reason === "") {

        showToast(
            "Please provide ownership details"
        );

        return;

    }


    const item =
        database.items.find(
            item => item.id === itemID
        );


    if (!item) return;


    const claim = {

        id: generateID("CLAIM"),

        itemID: itemID,

        itemName: item.name,

        claimer:
            database.user.name,

        reason: reason,

        proof: proof,

        status: "pending"

    };


    database.claims.push(claim);


    /* Notification */

    database.notifications.unshift({

        id: generateID("N"),

        message:
            `Claim submitted for "${item.name}".
            Ownership verification is pending.`,

        time:
            new Date().toLocaleString()

    });


    saveDatabase();

    closeClaim();


    showToast(
        "Claim submitted for verification"
    );

}


/* =====================================================
   VERIFY CLAIM
   ===================================================== */

function approveClaim(claimID) {

    const claim =
        database.claims.find(
            c => c.id === claimID
        );


    const item =
        database.items.find(
            i => i.id === claim.itemID
        );


    if (!claim || !item) return;


    /* CLAIM VALID */

    claim.status = "approved";


    /* ITEM RETURNED */

    item.status = "returned";


    database.notifications.unshift({

        id: generateID("N"),

        message:
            `Ownership verified.
            "${item.name}" has been returned.`,

        time:
            new Date().toLocaleString()

    });


    saveDatabase();


    showToast(
        "Claim approved - Item Returned"
    );

}


/* =====================================================
   REJECT CLAIM
   ===================================================== */

function rejectClaim(claimID) {

    const claim =
        database.claims.find(
            c => c.id === claimID
        );


    if (!claim) return;


    claim.status = "rejected";


    database.notifications.unshift({

        id: generateID("N"),

        message:
            `Claim for "${claim.itemName}"
            was rejected.`,

        time:
            new Date().toLocaleString()

    });


    saveDatabase();


    showToast(
        "Claim rejected"
    );

}


/* =====================================================
   DISPLAY CLAIMS
   ===================================================== */

function displayClaims() {

    const box =
        document.getElementById(
            "claimsList"
        );


    if (database.claims.length === 0) {

        box.innerHTML = `

            <div class="empty">

                No claims yet.

                <br><br>

                When a matching found item is
                available, the owner can claim it.

            </div>

        `;

        return;

    }


    box.innerHTML =
        database.claims
        .slice()
        .reverse()
        .map(claim => `

        <div class="claim">

            <div>

                <h3>
                    ${claim.itemName}
                </h3>

                <p>

                    Claimed by:
                    <b>${claim.claimer}</b>

                    <br>

                    Reason:
                    ${claim.reason}

                    <br>

                    ${
                        claim.proof
                        ?
                        "Verification: " +
                        claim.proof
                        :
                        ""
                    }

                </p>

            </div>


            <div>

                <span
                    class="status ${claim.status}">

                    ${claim.status}

                </span>


                ${
                    claim.status === "pending"

                    ?

                    `

                    <br><br>

                    <button
                        class="primary-btn"
                        onclick="approveClaim('${claim.id}')">

                        Verify & Return

                    </button>


                    <button
                        class="outline-btn"
                        onclick="rejectClaim('${claim.id}')">

                        Reject

                    </button>

                    `

                    :

                    ""

                }

            </div>

        </div>

    `)
    .join("");

}


/* =====================================================
   NOTIFICATIONS
   ===================================================== */

function displayNotifications() {

    const box =
        document.getElementById(
            "notificationsList"
        );


    if (
        database.notifications.length === 0
    ) {

        box.innerHTML = `

            <div class="empty">

                No notifications.

            </div>

        `;

        return;

    }


    box.innerHTML =
        database.notifications
        .slice(0,8)
        .map(notification => `

        <div class="notification">

            🔔

            ${notification.message}

            <small>
                ${notification.time}
            </small>

        </div>

    `)
    .join("");

}


/* =====================================================
   STATISTICS
   ===================================================== */

function displayStatistics() {

    const total =
        database.items.length;


    const lost =
        database.items.filter(
            item =>
                item.type === "lost" &&
                item.status === "active"
        ).length;


    const found =
        database.items.filter(
            item =>
                item.type === "found" &&
                item.status === "active"
        ).length;


    const returned =
        database.items.filter(
            item =>
                item.status === "returned"
        ).length;


    document.getElementById(
        "statistics"
    ).innerHTML = `

        <div class="stat">

            <strong>${total}</strong>

            <span>
                Total Reports
            </span>

        </div>


        <div class="stat">

            <strong>${lost}</strong>

            <span>
                Active Lost Items
            </span>

        </div>


        <div class="stat">

            <strong>${found}</strong>

            <span>
                Active Found Items
            </span>

        </div>


        <div class="stat">

            <strong>${returned}</strong>

            <span>
                Items Returned
            </span>

        </div>

    `;

}


/* =====================================================
   CLEAR NOTIFICATIONS
   ===================================================== */

function clearNotifications() {

    database.notifications = [];

    saveDatabase();

    showToast(
        "Notifications cleared"
    );

}


/* =====================================================
   RESTORE REAL FLASK LOGIN SESSION
   ===================================================== */

async function restoreSession() {
    try {
        const response = await fetch("/api/me", { credentials: "same-origin" });
        const result = await response.json();
        database.user = result.user || null;
    } catch (error) {
        database.user = null;
    }
    saveDatabase();
    updateAuthButtons();
}


/* =====================================================
   DISPLAY EVERYTHING
   ===================================================== */

function displayAll() {

    document.getElementById(
        "userName"
    ).innerText =
        database.user
        ?
        database.user.name
        :
        "Guest";

    updateAuthButtons();

    displayItems();

    displayClaims();

    displayNotifications();

    displayStatistics();

}


/* =====================================================
   SEARCH / FILTER
   ===================================================== */

document.getElementById(
    "filterType"
).addEventListener(
    "change",
    displayItems
);


document.getElementById(
    "searchBox"
).addEventListener(
    "input",
    displayItems
);


/* =====================================================
   DEFAULT DATE
   ===================================================== */

document.getElementById(
    "itemDate"
).value =
    new Date()
    .toISOString()
    .split("T")[0];


/* =====================================================
   START WEBSITE
   ===================================================== */

displayAll();
restoreSession();