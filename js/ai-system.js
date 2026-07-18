/* ============================================
   BIOMEXA AI ASSISTANT - JAVASCRIPT
   ============================================ */

// Medicine Database with your actual products
const medicineDB = {
    telmexa: {
        name: 'Telmexa AM',
        dosage: 'Telmisartan 40mg + Amlodipine 5mg',
        icon: '🫀',
        composition: 'Each tablet contains Telmisartan 40 mg and Amlodipine Besylate equivalent to Amlodipine 5 mg. Telmisartan is an angiotensin II receptor blocker (ARB). Amlodipine is a calcium channel blocker (CCB).',
        indications: 'Treatment of hypertension (high blood pressure) in adult patients. Effective for patients whose blood pressure is not adequately controlled on monotherapy. Also provides cardiovascular protection.',
        dosageInstr: 'Take ONE tablet once daily, preferably in the MORNING or at BEDTIME. For best results, take at the same time every day. Do not crush or chew the tablet. Swallow whole with water.',
        foodAlert: '⚠️ Take on an EMPTY STOMACH or 1 hour before food for optimal absorption. Avoid grapefruit and grapefruit juice — they can increase amlodipine levels dangerously. Limit alcohol as it may lower blood pressure too much.',
        safety: 'Do not use if pregnant or planning pregnancy. May cause dizziness — avoid driving until you know how it affects you. Monitor blood pressure regularly. Report swelling of ankles, severe dizziness, or persistent cough to your doctor.',
        audioScript: 'Hello, I am your Biomexa AI assistant. You are taking Telmexa AM, which contains Telmisartan 40 milligrams and Amlodipine 5 milligrams. Take one tablet once daily, preferably at bedtime, because blood pressure naturally rises in the early morning. Take on an empty stomach or one hour before food for best absorption. Avoid grapefruit and grapefruit juice completely, as they can dangerously increase the drug levels in your body. Limit alcohol. If you experience ankle swelling, severe dizziness, or persistent cough, contact your doctor immediately. Your Biomexa reminder will alert you at your scheduled time.',
        timing: 'bedtime',
        category: 'hypertension'
    },
    diabmexa: {
        name: 'Diabmexa-M',
        dosage: 'Metformin 500mg + Glimepiride 1mg',
        icon: '🩸',
        composition: 'Each tablet contains Metformin Hydrochloride 500 mg and Glimepiride 1 mg. Metformin is a biguanide that reduces glucose production in the liver. Glimepiride is a sulfonylurea that stimulates insulin secretion from pancreatic beta cells.',
        indications: 'Management of Type 2 Diabetes Mellitus in adults when diet, exercise, and single-agent therapy do not result in adequate glycemic control. Helps lower fasting and postprandial blood glucose levels.',
        dosageInstr: 'Take ONE tablet twice daily — one with BREAKFAST and one with DINNER. Always take WITH FOOD to reduce stomach upset and the risk of low blood sugar. Take at the same times every day.',
        foodAlert: '✓ ALWAYS take with food — preferably at the start of your meal. This reduces gastrointestinal side effects and prevents hypoglycemia. Avoid excessive alcohol — it increases the risk of lactic acidosis with metformin. Maintain consistent carbohydrate intake across meals.',
        safety: 'Monitor blood sugar regularly. Carry glucose tablets for low sugar episodes. Do not skip meals after taking this medicine. Inform your doctor before any surgery or contrast imaging. Kidney function should be monitored periodically.',
        audioScript: 'Hello, I am your Biomexa AI assistant. You are taking Diabmexa M, which contains Metformin 500 milligrams and Glimepiride 1 milligram. Take one tablet twice daily — one with breakfast and one with dinner. Always take this medicine WITH food, at the start of your meal. This prevents stomach upset and dangerous low blood sugar episodes. Avoid excessive alcohol. Maintain consistent meal timing and carbohydrate intake. Monitor your blood sugar regularly. Carry glucose tablets for emergencies. If you experience severe stomach pain, difficulty breathing, or confusion, seek medical help immediately. Your Biomexa reminder will alert you at meal times.',
        timing: 'with meals',
        category: 'diabetes'
    },
    metformin: {
        name: 'Metformin',
        dosage: '500mg',
        icon: '💊',
        composition: 'Metformin Hydrochloride 500 mg. A biguanide antihyperglycemic agent.',
        indications: 'Type 2 Diabetes Mellitus. Improves insulin sensitivity and reduces hepatic glucose production.',
        dosageInstr: 'Take with meals to reduce gastrointestinal side effects. Start with once daily, may increase to twice daily.',
        foodAlert: 'Take WITH food. Avoid excessive alcohol. Maintain consistent diet.',
        safety: 'Monitor kidney function. Risk of lactic acidosis in renal impairment. Hold before contrast studies.',
        audioScript: 'Take Metformin with your meals to reduce stomach upset. Avoid excessive alcohol.',
        timing: 'with meals',
        category: 'diabetes'
    },
    amlodipine: {
        name: 'Amlodipine',
        dosage: '5mg',
        icon: '💊',
        composition: 'Amlodipine Besylate 5 mg. A dihydropyridine calcium channel blocker.',
        indications: 'Hypertension and chronic stable angina. Relaxes blood vessels to improve blood flow.',
        dosageInstr: 'Take once daily, same time each day. Can be taken with or without food.',
        foodAlert: 'Avoid grapefruit and grapefruit juice. Limit alcohol.',
        safety: 'May cause ankle swelling, flushing, or dizziness. Monitor blood pressure. Do not stop abruptly.',
        audioScript: 'Take Amlodipine once daily at the same time. Avoid grapefruit completely.',
        timing: 'daily',
        category: 'hypertension'
    },
    doxycycline: {
        name: 'Doxycycline',
        dosage: '100mg',
        icon: '💊',
        composition: 'Doxycycline Hyclate 100 mg. A tetracycline antibiotic.',
        indications: 'Bacterial infections including respiratory, urinary tract, and skin infections.',
        dosageInstr: 'Take on an empty stomach with a full glass of water. Remain upright for 30 minutes.',
        foodAlert: '⚠️ Avoid dairy products, antacids, and iron supplements within 2 hours. Take with water only.',
        safety: 'Photosensitivity — use sunscreen. Not for children under 8 or pregnant women. Complete full course.',
        audioScript: 'Take Doxycycline on an empty stomach with plenty of water. Avoid milk, cheese, and calcium supplements for two hours before and after your dose. Stay upright for thirty minutes after taking it.',
        timing: 'empty stomach',
        category: 'antibiotic'
    },
    atorvastatin: {
        name: 'Atorvastatin',
        dosage: '20mg',
        icon: '💊',
        composition: 'Atorvastatin Calcium 20 mg. An HMG-CoA reductase inhibitor (statin).',
        indications: 'Hyperlipidemia and prevention of cardiovascular disease. Lowers LDL cholesterol.',
        dosageInstr: 'Take once daily in the EVENING or at BEDTIME. Cholesterol production peaks at night.',
        foodAlert: '⚠️ AVOID grapefruit and grapefruit juice completely. Limit alcohol.',
        safety: 'Monitor liver function. Report muscle pain or weakness. Not for pregnant or breastfeeding women.',
        audioScript: 'Take Atorvastatin in the evening or at bedtime, because your body makes most cholesterol at night. Avoid grapefruit and grapefruit juice completely.',
        timing: 'bedtime',
        category: 'cholesterol'
    },
    levothyroxine: {
        name: 'Levothyroxine',
        dosage: '50mcg',
        icon: '💊',
        composition: 'Levothyroxine Sodium 50 mcg. Synthetic thyroid hormone T4.',
        indications: 'Hypothyroidism. Replaces deficient thyroid hormone.',
        dosageInstr: 'Take on an EMPTY STOMACH, 30-60 minutes BEFORE breakfast, with water only.',
        foodAlert: '⚠️ Take on empty stomach. Avoid coffee, calcium, iron, and soy within 4 hours.',
        safety: 'Do not stop abruptly. Regular thyroid function tests needed. Dose adjustments may be needed.',
        audioScript: 'Take Levothyroxine first thing in the morning on an empty stomach, thirty to sixty minutes before breakfast, with water only. Avoid coffee, calcium supplements, and iron for four hours after.',
        timing: 'morning empty',
        category: 'thyroid'
    },
    prenatal: {
        name: 'Prenatal Vitamins',
        dosage: 'One daily',
        icon: '🤰',
        composition: 'Folic acid, Iron, Calcium, Vitamin D, DHA, and essential prenatal nutrients.',
        indications: 'Nutritional support during pregnancy and lactation. Prevents neural tube defects and anemia.',
        dosageInstr: 'Take ONE tablet daily with a meal. Best taken with orange juice or vitamin C source.',
        foodAlert: '✓ Take with food. Take iron with vitamin C for better absorption. Avoid tea or coffee within 2 hours.',
        safety: 'Do not exceed recommended dose. Store in a cool, dry place. Keep out of reach of children.',
        audioScript: 'Take your prenatal vitamin once daily with a meal. Take it with orange juice or another source of vitamin C for better iron absorption. Avoid tea and coffee for two hours before and after taking it.',
        timing: 'with breakfast',
        category: 'pregnancy'
    }
};

// App State
let currentMedicine = null;
let reminders = JSON.parse(localStorage.getItem('biomexa_reminders')) || [];
let doseHistory = JSON.parse(localStorage.getItem('biomexa_history')) || [];
let isSpeaking = false;
let speechUtterance = null;

// ============================================
// SCREEN NAVIGATION
// ============================================
function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(screenId).classList.add('active');

    if (screenId === 'remindersScreen') renderReminders();
    if (screenId === 'historyScreen') renderHistory();
    if (screenId === 'welcomeScreen') renderRecentScans();
}

// ============================================
// MEDICINE SCANNING
// ============================================
function scanMedicine(medKey) {
    const med = medicineDB[medKey];
    if (!med) return;

    currentMedicine = { ...med, key: medKey, scannedAt: new Date().toISOString() };

    // Save to recent scans
    let recent = JSON.parse(localStorage.getItem('biomexa_recent')) || [];
    recent.unshift({ key: medKey, name: med.name, time: new Date().toLocaleString() });
    recent = recent.slice(0, 10);
    localStorage.setItem('biomexa_recent', JSON.stringify(recent));

    // Populate medicine card
    document.getElementById('medIcon').textContent = med.icon;
    document.getElementById('medName').textContent = med.name;
    document.getElementById('medDosage').textContent = med.dosage;
    document.getElementById('medComposition').textContent = med.composition;
    document.getElementById('medIndications').textContent = med.indications;
    document.getElementById('medDosageInstr').textContent = med.dosageInstr;
    document.getElementById('medFoodAlert').textContent = med.foodAlert;
    document.getElementById('medSafety').textContent = med.safety;

    showScreen('medicineScreen');

    // Auto-play audio after a short delay
    setTimeout(() => {
        showToast('🔊 Tap "Listen" to hear AI guidance', 'info');
    }, 800);
}

// ============================================
// AI AUDIO (Text-to-Speech)
// ============================================
function playMedicineAudio() {
    if (!currentMedicine) return;

    const btn = document.getElementById('playAudioBtn');
    const visualizer = document.getElementById('audioVisualizer');

    if (isSpeaking) {
        // Stop speaking
        window.speechSynthesis.cancel();
        isSpeaking = false;
        btn.classList.remove('playing');
        btn.querySelector('.audio-text').textContent = 'Listen to AI Audio Guidance';
        visualizer.classList.remove('active');
        return;
    }

    // Check if speech synthesis is supported
    if (!window.speechSynthesis) {
        showToast('❌ Audio not supported in this browser', 'error');
        return;
    }

    // Create utterance
    speechUtterance = new SpeechSynthesisUtterance(currentMedicine.audioScript);
    speechUtterance.rate = 0.9;
    speechUtterance.pitch = 1;
    speechUtterance.volume = 1;

    // Try to use a good voice
    const voices = window.speechSynthesis.getVoices();
    const preferredVoice = voices.find(v => v.name.includes('Google US English')) 
        || voices.find(v => v.name.includes('Samantha'))
        || voices.find(v => v.lang === 'en-US')
        || voices[0];
    if (preferredVoice) speechUtterance.voice = preferredVoice;

    speechUtterance.onstart = () => {
        isSpeaking = true;
        btn.classList.add('playing');
        btn.querySelector('.audio-text').textContent = '🔊 Playing AI Guidance...';
        visualizer.classList.add('active');
    };

    speechUtterance.onend = () => {
        isSpeaking = false;
        btn.classList.remove('playing');
        btn.querySelector('.audio-text').textContent = 'Listen to AI Audio Guidance';
        visualizer.classList.remove('active');
    };

    speechUtterance.onerror = () => {
        isSpeaking = false;
        btn.classList.remove('playing');
        btn.querySelector('.audio-text').textContent = 'Listen to AI Audio Guidance';
        visualizer.classList.remove('active');
        showToast('❌ Audio playback failed. Try again.', 'error');
    };

    window.speechSynthesis.speak(speechUtterance);
}

// Load voices when available
window.speechSynthesis?.getVoices();
if (window.speechSynthesis) {
    window.speechSynthesis.onvoiceschanged = () => {
        window.speechSynthesis.getVoices();
    };
}

// ============================================
// SET REMINDER
// ============================================
function setReminder() {
    if (!currentMedicine) return;
    document.getElementById('reminderMedName').value = currentMedicine.name;

    // Set default time based on medicine timing
    const timeInput = document.getElementById('reminderTime');
    if (currentMedicine.timing === 'bedtime') {
        timeInput.value = '22:00';
    } else if (currentMedicine.timing === 'morning empty') {
        timeInput.value = '06:00';
    } else if (currentMedicine.timing === 'with meals') {
        timeInput.value = '08:00';
    } else {
        timeInput.value = '08:00';
    }

    document.getElementById('reminderModal').classList.add('active');
}

function closeModal() {
    document.getElementById('reminderModal').classList.remove('active');
}

function saveReminder() {
    const medName = document.getElementById('reminderMedName').value;
    const time = document.getElementById('reminderTime').value;
    const freq = document.getElementById('reminderFreq').value;

    const notifTypes = [];
    if (document.getElementById('notifPush').checked) notifTypes.push('push');
    if (document.getElementById('notifSMS').checked) notifTypes.push('sms');
    if (document.getElementById('notifWhatsApp').checked) notifTypes.push('whatsapp');
    if (document.getElementById('notifAudio').checked) notifTypes.push('audio');

    const reminder = {
        id: Date.now(),
        medicine: medName,
        time: time,
        frequency: freq,
        notifications: notifTypes,
        status: 'pending',
        createdAt: new Date().toISOString()
    };

    reminders.push(reminder);
    localStorage.setItem('biomexa_reminders', JSON.stringify(reminders));

    closeModal();
    showToast('✅ Reminder saved! You will be notified at ' + time, 'success');

    // Schedule simulated notification
    scheduleSimulatedNotification(reminder);
}

// ============================================
// MARK AS TAKEN
// ============================================
function markTaken() {
    if (!currentMedicine) return;

    const dose = {
        medicine: currentMedicine.name,
        dosage: currentMedicine.dosage,
        takenAt: new Date().toISOString(),
        status: 'taken'
    };

    doseHistory.push(dose);
    localStorage.setItem('biomexa_history', JSON.stringify(doseHistory));

    // Update reminder status if exists
    const reminder = reminders.find(r => r.medicine === currentMedicine.name && r.status === 'pending');
    if (reminder) {
        reminder.status = 'taken';
        localStorage.setItem('biomexa_reminders', JSON.stringify(reminders));
    }

    showToast('✅ Dose recorded! Great job staying on track.', 'success');

    // Simulate confirmation with audio
    if (window.speechSynthesis) {
        const confirmMsg = new SpeechSynthesisUtterance('Dose confirmed. Thank you for staying on track with your treatment.');
        confirmMsg.rate = 1;
        confirmMsg.volume = 0.8;
        window.speechSynthesis.speak(confirmMsg);
    }
}

// ============================================
// SIMULATED NOTIFICATIONS
// ============================================
function scheduleSimulatedNotification(reminder) {
    // For demo: show notification after 10 seconds
    setTimeout(() => {
        showSimulatedNotification(reminder);
    }, 10000);
}

function showSimulatedNotification(reminder) {
    const notif = document.getElementById('simNotification');
    const body = document.getElementById('notifBody');

    let message = `Time to take your ${reminder.medicine}! `;

    // Add food guidance based on medicine
    const med = Object.values(medicineDB).find(m => m.name === reminder.medicine);
    if (med) {
        if (med.timing === 'bedtime') message += 'Take at bedtime on an empty stomach.';
        else if (med.timing === 'with meals') message += 'Take WITH your meal now.';
        else if (med.timing === 'empty stomach') message += 'Take on empty stomach with water.';
        else if (med.timing === 'morning empty') message += 'Take on empty stomach before breakfast.';
        else message += 'Take as directed by your doctor.';
    }

    body.textContent = message;
    notif.classList.add('active');

    // Play audio notification if enabled
    if (reminder.notifications.includes('audio') && window.speechSynthesis) {
        const audioMsg = new SpeechSynthesisUtterance(message);
        audioMsg.rate = 0.9;
        window.speechSynthesis.speak(audioMsg);
    }

    // Auto-hide after 30 seconds
    setTimeout(() => {
        notif.classList.remove('active');
    }, 30000);
}

function confirmDose() {
    document.getElementById('simNotification').classList.remove('active');
    showToast('✅ Dose confirmed! Keep up the good work.', 'success');

    // Record in history
    const dose = {
        medicine: currentMedicine?.name || 'Medicine',
        takenAt: new Date().toISOString(),
        status: 'taken'
    };
    doseHistory.push(dose);
    localStorage.setItem('biomexa_history', JSON.stringify(doseHistory));
}

function snoozeReminder() {
    document.getElementById('simNotification').classList.remove('active');
    showToast('⏰ Reminder snoozed for 10 minutes', 'warning');

    setTimeout(() => {
        showSimulatedNotification({ medicine: currentMedicine?.name || 'Medicine', notifications: ['audio'] });
    }, 10000);
}

// ============================================
// RENDER REMINDERS
// ============================================
function renderReminders() {
    const list = document.getElementById('remindersList');
    const filterBtns = document.querySelectorAll('.filter-btn');

    filterBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            filterBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            renderRemindersList(btn.dataset.filter || 'all');
        });
    });

    renderRemindersList('all');
}

function renderRemindersList(filter) {
    const list = document.getElementById('remindersList');
    let filtered = reminders;

    if (filter === 'pending') filtered = reminders.filter(r => r.status === 'pending');
    if (filter === 'taken') filtered = reminders.filter(r => r.status === 'taken');
    if (filter === 'missed') filtered = reminders.filter(r => r.status === 'missed');

    if (filtered.length === 0) {
        list.innerHTML = '<div class="empty-state">📭 No reminders yet. Scan a medicine to set one up!</div>';
        return;
    }

    list.innerHTML = filtered.map(r => {
        const [hours, minutes] = r.time.split(':');
        const ampm = hours >= 12 ? 'PM' : 'AM';
        const displayHour = hours % 12 || 12;

        const notifIcons = r.notifications.map(n => {
            if (n === 'push') return '🔔';
            if (n === 'sms') return '💬';
            if (n === 'whatsapp') return '📱';
            if (n === 'audio') return '🔊';
            return '';
        }).join(' ');

        return `
            <div class="reminder-item">
                <div class="reminder-time">
                    <div class="time">${displayHour}:${minutes}</div>
                    <div class="ampm">${ampm}</div>
                </div>
                <div class="reminder-info">
                    <div class="reminder-name">${r.medicine}</div>
                    <div class="reminder-dose">${r.frequency} · ${notifIcons}</div>
                </div>
                <div class="reminder-status ${r.status}">${r.status}</div>
            </div>
        `;
    }).join('');
}

// ============================================
// RENDER HISTORY
// ============================================
function renderHistory() {
    // Calculate stats
    const totalDoses = doseHistory.length;
    const takenDoses = doseHistory.filter(d => d.status === 'taken').length;
    const adherenceRate = totalDoses > 0 ? Math.round((takenDoses / totalDoses) * 100) : 0;

    // Calculate streak
    let streak = 0;
    const today = new Date().toDateString();
    const sortedHistory = [...doseHistory].sort((a, b) => new Date(b.takenAt) - new Date(a.takenAt));

    document.getElementById('adherenceRate').textContent = adherenceRate + '%';
    document.getElementById('streakDays').textContent = streak;
    document.getElementById('totalDoses').textContent = totalDoses;

    // Render chart
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const chartData = [2, 3, 2, 3, 1, 2, 3]; // Demo data

    document.getElementById('historyChart').innerHTML = days.map((day, i) => `
        <div class="chart-bar-wrapper">
            <div class="chart-bar" style="height: ${chartData[i] * 25}px;"></div>
            <div class="chart-bar-label">${day}</div>
        </div>
    `).join('');

    // Render history list
    const list = document.getElementById('historyList');
    if (doseHistory.length === 0) {
        list.innerHTML = '<div class="empty-state">📊 No history yet. Take your first dose!</div>';
        return;
    }

    list.innerHTML = doseHistory.slice(-10).reverse().map(d => `
        <div class="scan-item">
            <div class="scan-item-icon">💊</div>
            <div class="scan-item-info">
                <div class="scan-item-name">${d.medicine}</div>
                <div class="scan-item-time">${new Date(d.takenAt).toLocaleString()}</div>
            </div>
            <div class="scan-item-arrow">✓</div>
        </div>
    `).join('');
}

// ============================================
// RENDER RECENT SCANS
// ============================================
function renderRecentScans() {
    const list = document.getElementById('recentScanList');
    const recent = JSON.parse(localStorage.getItem('biomexa_recent')) || [];

    if (recent.length === 0) {
        list.innerHTML = '<div class="empty-state">📱 Scan your first medicine to see it here!</div>';
        return;
    }

    list.innerHTML = recent.slice(0, 5).map(item => {
        const med = medicineDB[Object.keys(medicineDB).find(k => medicineDB[k].name === item.name)];
        return `
            <div class="scan-item" onclick="scanMedicine('${item.key}')">
                <div class="scan-item-icon">${med?.icon || '💊'}</div>
                <div class="scan-item-info">
                    <div class="scan-item-name">${item.name}</div>
                    <div class="scan-item-time">${item.time}</div>
                </div>
                <div class="scan-item-arrow">→</div>
            </div>
        `;
    }).join('');
}

// ============================================
// TOAST NOTIFICATIONS
// ============================================
function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    const icons = { success: '✅', warning: '⚠️', error: '❌', info: 'ℹ️' };
    toast.innerHTML = `<span class="toast-icon">${icons[type] || 'ℹ️'}</span><span class="toast-text">${message}</span>`;

    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(-20px)';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// ============================================
// DEMO NOTIFICATION (for testing)
// ============================================
function triggerDemoNotification() {
    showSimulatedNotification({
        medicine: 'Telmexa AM',
        notifications: ['push', 'audio']
    });
}

// ============================================
// INITIALIZE
// ============================================
document.addEventListener('DOMContentLoaded', () => {
    renderRecentScans();

    // Add demo data if empty
    if (reminders.length === 0) {
        reminders = [
            { id: 1, medicine: 'Telmexa AM', time: '22:00', frequency: 'daily', notifications: ['push', 'audio'], status: 'pending', createdAt: new Date().toISOString() },
            { id: 2, medicine: 'Diabmexa-M', time: '08:00', frequency: 'twice', notifications: ['push', 'whatsapp'], status: 'pending', createdAt: new Date().toISOString() }
        ];
        localStorage.setItem('biomexa_reminders', JSON.stringify(reminders));
    }

    // Request notification permission
    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
    }

    console.log('🚀 Biomexa AI Assistant loaded!');
    console.log('💊 Products: Telmexa AM, Diabmexa-M');
});
