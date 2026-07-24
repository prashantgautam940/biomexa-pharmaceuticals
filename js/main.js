/* ============================================
   BIOMEXA PHARMACEUTICALS - MAIN JAVASCRIPT
   ============================================ */

document.addEventListener('DOMContentLoaded', function() {

    // ============================================
    // PARTICLE ANIMATION
    // ============================================
    const particlesContainer = document.getElementById('particles');
    if (particlesContainer) {
        for (let i = 0; i < 40; i++) {
            const p = document.createElement('div');
            p.className = 'particle';
            p.style.left = Math.random() * 100 + '%';
            p.style.animationDelay = Math.random() * 20 + 's';
            p.style.animationDuration = (12 + Math.random() * 15) + 's';
            p.style.width = (2 + Math.random() * 3) + 'px';
            p.style.height = p.style.width;
            particlesContainer.appendChild(p);
        }
    }

    // ============================================
    // NAVBAR SCROLL EFFECT
    // ============================================
    const navbar = document.getElementById('navbar');
    let lastScroll = 0;

    window.addEventListener('scroll', function() {
        const currentScroll = window.scrollY;

        if (currentScroll > 50) {
            navbar.classList.add('scrolled');
        } else {
            navbar.classList.remove('scrolled');
        }

        // Hide/show navbar on scroll direction
        if (currentScroll > lastScroll && currentScroll > 300) {
            navbar.style.transform = 'translateY(-100%)';
        } else {
            navbar.style.transform = 'translateY(0)';
        }
        lastScroll = currentScroll;
    });

    navbar.style.transition = 'transform 0.3s ease, padding 0.3s ease, background 0.3s ease, box-shadow 0.3s ease';

    // ============================================
    // MOBILE MENU
    // ============================================
    const mobileMenuBtn = document.getElementById('mobileMenuBtn');
    const mobileMenu = document.getElementById('mobileMenu');

    if (mobileMenuBtn && mobileMenu) {
        mobileMenuBtn.addEventListener('click', function() {
            this.classList.toggle('active');
            mobileMenu.classList.toggle('active');
            document.body.style.overflow = mobileMenu.classList.contains('active') ? 'hidden' : '';
        });

        mobileMenu.querySelectorAll('a').forEach(link => {
            link.addEventListener('click', () => {
                mobileMenuBtn.classList.remove('active');
                mobileMenu.classList.remove('active');
                document.body.style.overflow = '';
            });
        });
    }

    // ============================================
    // SMOOTH SCROLL
    // ============================================
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function(e) {
            e.preventDefault();
            const targetId = this.getAttribute('href');
            const target = document.querySelector(targetId);
            if (target) {
                const offset = navbar.offsetHeight + 20;
                const targetPosition = target.getBoundingClientRect().top + window.scrollY - offset;
                window.scrollTo({
                    top: targetPosition,
                    behavior: 'smooth'
                });
            }
        });
    });

    // ============================================
    // ACTIVE NAV LINK
    // ============================================
    const sections = document.querySelectorAll('section[id]');
    const navLinks = document.querySelectorAll('.nav-link');

    function updateActiveNav() {
        let current = '';
        const scrollPos = window.scrollY + 200;

        sections.forEach(section => {
            const sectionTop = section.offsetTop;
            const sectionHeight = section.offsetHeight;
            if (scrollPos >= sectionTop && scrollPos < sectionTop + sectionHeight) {
                current = section.getAttribute('id');
            }
        });

        navLinks.forEach(link => {
            link.classList.remove('active');
            if (link.getAttribute('href') === '#' + current) {
                link.classList.add('active');
            }
        });
    }

    window.addEventListener('scroll', updateActiveNav);
    updateActiveNav();

    // ============================================
    // SCROLL ANIMATIONS (Intersection Observer)
    // ============================================
    const fadeElements = document.querySelectorAll('.fade-in');

    const fadeObserver = new IntersectionObserver((entries) => {
        entries.forEach((entry, index) => {
            if (entry.isIntersecting) {
                setTimeout(() => {
                    entry.target.classList.add('visible');
                }, index * 100);
                fadeObserver.unobserve(entry.target);
            }
        });
    }, { 
        threshold: 0.1,
        rootMargin: '0px 0px -50px 0px'
    });

    fadeElements.forEach(el => fadeObserver.observe(el));

    // ============================================
    // COUNTER ANIMATION
    // ============================================
    const counters = document.querySelectorAll('.stat-number[data-count]');
    const dashCounters = document.querySelectorAll('.dash-metric-value[data-count]');

    function animateCounter(el, target, duration = 2000) {
        const start = 0;
        const startTime = performance.now();

        function update(currentTime) {
            const elapsed = currentTime - startTime;
            const progress = Math.min(elapsed / duration, 1);
            const easeOut = 1 - Math.pow(1 - progress, 3);
            const current = Math.floor(start + (target - start) * easeOut);
            el.textContent = current;

            if (progress < 1) {
                requestAnimationFrame(update);
            } else {
                el.textContent = target;
            }
        }

        requestAnimationFrame(update);
    }

    const counterObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const el = entry.target;
                const target = parseInt(el.getAttribute('data-count'));
                animateCounter(el, target);
                counterObserver.unobserve(el);
            }
        });
    }, { threshold: 0.5 });

    counters.forEach(c => counterObserver.observe(c));
    dashCounters.forEach(c => counterObserver.observe(c));

    // ============================================
    // DISEASE JOURNEY DATA & INTERACTION
    // ============================================
    const journeyData = {
        diabetes: {
            steps: [
                { num: 1, title: 'Prescription', desc: 'Doctor prescribes Metformin + lifestyle changes' },
                { num: 2, title: 'QR Medicine', desc: 'Patient collects QR-coded medicine from pharmacy' },
                { num: 3, title: 'Scan', desc: 'Scans code, gets AI audio: "Take with evening meal"' },
                { num: 4, title: 'Reminder', desc: 'Daily WhatsApp/SMS: "Take Metformin at 7 PM with dinner"' },
                { num: 5, title: 'Confirmation', desc: 'Patient confirms dose intake in the app' },
                { num: 6, title: 'Data Analysis', desc: 'Glucose readings + adherence analyzed by AI' },
                { num: 7, title: 'Better Outcomes', desc: 'Doctor sees trends; HbA1c improves over time' }
            ],
            detail: {
                challenge: 'Diabetes patients often miss doses due to complex regimens. Food timing is critical — Metformin must be taken with meals to avoid GI upset. Without guidance, patients skip doses, leading to poor glucose control and complications.',
                solution: 'QR scan provides audio guidance in local language. Reminders include food instructions: "Take with your evening meal." Glucose readings sync to the doctor dashboard. AI flags patients with declining adherence before HbA1c worsens.'
            }
        },
        hypertension: {
            steps: [
                { num: 1, title: 'Prescription', desc: 'Doctor prescribes bedtime antihypertensive' },
                { num: 2, title: 'QR Medicine', desc: 'Patient collects QR-coded medicine from pharmacy' },
                { num: 3, title: 'Scan', desc: 'Audio: "Take at bedtime — BP rises in morning"' },
                { num: 4, title: 'Reminder', desc: 'Circadian reminder at 10 PM: "Time for your BP medicine"' },
                { num: 5, title: 'Confirmation', desc: 'Patient confirms intake before sleep' },
                { num: 6, title: 'Data Analysis', desc: 'BP readings + timing adherence analyzed' },
                { num: 7, title: 'Better Outcomes', desc: 'Morning BP controlled; stroke risk reduced' }
            ],
            detail: {
                challenge: 'Blood pressure rises in early morning. Some antihypertensives work better at bedtime. Patients often take them at random times, missing the circadian window and increasing cardiovascular risk.',
                solution: 'Biological clock-aligned reminders at 10 PM. QR audio explains WHY bedtime matters. Dashboard compares timing adherence with BP trends. Doctor sees if timing correlates with morning BP spikes.'
            }
        },
        tb: {
            steps: [
                { num: 1, title: 'Prescription', desc: 'DOTS program — strict 6-month regimen' },
                { num: 2, title: 'QR Medicine', desc: 'Patient receives QR-coded TB medication' },
                { num: 3, title: 'Scan', desc: 'Audio: "Take on empty stomach, 1 hour before food"' },
                { num: 4, title: 'Reminder', desc: 'Daily observed therapy reminder via WhatsApp' },
                { num: 5, title: 'Confirmation', desc: 'Patient confirms + uploads photo if needed' },
                { num: 6, title: 'Data Analysis', desc: 'Strict adherence tracked; missed doses flagged' },
                { num: 7, title: 'Better Outcomes', desc: 'Treatment completed; MDR-TB prevented' }
            ],
            detail: {
                challenge: 'TB requires 6+ months of strict daily therapy. Missing even a few doses causes treatment failure and multidrug-resistant TB (MDR-TB). Food interactions with rifampicin reduce drug absorption significantly.',
                solution: 'Daily observed therapy via app. QR alerts: "Take on empty stomach." Healthcare worker gets real-time alerts for missed doses. Dashboard flags at-risk patients for immediate intervention. MDR-TB prevention at scale.'
            }
        },
        pregnancy: {
            steps: [
                { num: 1, title: 'Prescription', desc: 'Prenatal vitamins + iron supplements prescribed' },
                { num: 2, title: 'QR Medicine', desc: 'Patient collects QR-coded prenatal pack' },
                { num: 3, title: 'Scan', desc: 'Audio: "Iron with orange juice, not with tea or coffee"' },
                { num: 4, title: 'Reminder', desc: 'Morning reminder: "Take iron with vitamin C"' },
                { num: 5, title: 'Confirmation', desc: 'Patient confirms daily prenatal intake' },
                { num: 6, title: 'Data Analysis', desc: 'Hemoglobin trends + adherence correlated' },
                { num: 7, title: 'Better Outcomes', desc: 'Healthy pregnancy; reduced anemia risk' }
            ],
            detail: {
                challenge: 'Pregnant women need safe, consistent medication guidance. Iron absorption is blocked by tea/coffee. Folic acid timing matters for neural tube development. Anxiety about medication safety leads to non-adherence.',
                solution: 'QR provides pregnancy-safe guidance. Reminders: "Take iron with orange juice. Avoid tea for 2 hours." Dashboard tracks hemoglobin trends. Doctor intervenes early if anemia develops despite adherence.'
            }
        },
        cholesterol: {
            steps: [
                { num: 1, title: 'Prescription', desc: 'Evening statin prescribed for cholesterol' },
                { num: 2, title: 'QR Medicine', desc: 'Patient collects QR-coded statin from pharmacy' },
                { num: 3, title: 'Scan', desc: 'Audio: "Take at bedtime — cholesterol peaks at night"' },
                { num: 4, title: 'Reminder', desc: 'Evening reminder: "Time for your statin — avoid grapefruit"' },
                { num: 5, title: 'Confirmation', desc: 'Patient confirms bedtime dose intake' },
                { num: 6, title: 'Data Analysis', desc: 'Lipid profile + adherence timing analyzed' },
                { num: 7, title: 'Better Outcomes', desc: 'LDL cholesterol reduced; cardiovascular risk lowered' }
            ],
            detail: {
                challenge: 'Cholesterol production is higher at night. Certain statins are commonly prescribed for evening use. Grapefruit can dangerously increase statin levels. Patients often take them at wrong times or with wrong foods.',
                solution: 'Circadian-aware reminders at bedtime. QR alerts about grapefruit interaction. Dashboard tracks lipid profile trends against adherence timing. Doctor adjusts regimen based on real-world data.'
            }
        }
    };

    const journeyStepsEl = document.getElementById('journeySteps');
    const journeyDetailEl = document.getElementById('journeyDetail');
    const diseaseTabs = document.querySelectorAll('.disease-tab');

    function renderJourney(disease) {
        const data = journeyData[disease];
        if (!data) return;

        // Render steps
        journeyStepsEl.innerHTML = data.steps.map(step => `
            <div class="journey-step">
                <div class="step-number">${step.num}</div>
                <div class="step-title">${step.title}</div>
                <div class="step-desc">${step.desc}</div>
            </div>
        `).join('');

        // Render detail cards
        journeyDetailEl.innerHTML = `
            <div class="journey-detail-cards fade-in visible">
                <div class="journey-detail-card">
                    <h4>🩺 The Challenge</h4>
                    <p>${data.detail.challenge}</p>
                </div>
                <div class="journey-detail-card">
                    <h4>💡 Biomexa Solution</h4>
                    <p>${data.detail.solution}</p>
                </div>
            </div>
        `;

        // Animate steps
        const steps = journeyStepsEl.querySelectorAll('.journey-step');
        steps.forEach((step, i) => {
            step.style.opacity = '0';
            step.style.transform = 'translateY(20px)';
            setTimeout(() => {
                step.style.transition = 'all 0.5s ease';
                step.style.opacity = '1';
                step.style.transform = 'translateY(0)';
            }, i * 100);
        });
    }

    // Initialize with diabetes
    renderJourney('diabetes');

    // Tab click handlers
    diseaseTabs.forEach(tab => {
        tab.addEventListener('click', function() {
            diseaseTabs.forEach(t => t.classList.remove('active'));
            this.classList.add('active');
            renderJourney(this.dataset.disease);
        });
    });

    // ============================================
    // DASHBOARD CHARTS
    // ============================================
    function renderChart(containerId, data, color) {
        const container = document.getElementById(containerId);
        if (!container) return;

        const maxVal = Math.max(...data);
        const labels = containerId === 'adherenceChart' 
            ? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
            : ['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7'];

        container.innerHTML = data.map((val, i) => {
            const height = (val / maxVal) * 100;
            return `
                <div class="chart-bar" style="height: 0%;" data-height="${height}%">
                    <span class="chart-bar-label">${labels[i]}</span>
                </div>
            `;
        }).join('');

        // Animate bars
        setTimeout(() => {
            container.querySelectorAll('.chart-bar').forEach((bar, i) => {
                setTimeout(() => {
                    bar.style.height = bar.dataset.height;
                }, i * 100);
            });
        }, 500);
    }

    const adherenceData = [60, 75, 65, 85, 90, 70, 88];
    const therapeuticData = [45, 55, 62, 70, 78, 85, 92];

    const chartObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                renderChart('adherenceChart', adherenceData, 'var(--accent)');
                renderChart('therapeuticChart', therapeuticData, 'var(--accent-light)');
                chartObserver.unobserve(entry.target);
            }
        });
    }, { threshold: 0.3 });

    const dashboardPreview = document.querySelector('.dashboard-preview');
    if (dashboardPreview) {
        chartObserver.observe(dashboardPreview);
    }

    // ============================================
    // DASHBOARD FILTER BUTTONS
    // ============================================
    document.querySelectorAll('.dash-filter').forEach(btn => {
        btn.addEventListener('click', function() {
            this.parentElement.querySelectorAll('.dash-filter').forEach(b => b.classList.remove('active'));
            this.classList.add('active');
        });
    });

    // ============================================
    // ECOSYSTEM ITEM HOVER EFFECTS
    // ============================================
    document.querySelectorAll('.ecosystem-item').forEach(item => {
        item.addEventListener('mouseenter', function() {
            document.querySelectorAll('.ecosystem-item').forEach(i => {
                if (i !== this) i.style.opacity = '0.5';
            });
        });
        item.addEventListener('mouseleave', function() {
            document.querySelectorAll('.ecosystem-item').forEach(i => {
                i.style.opacity = '1';
            });
        });
    });

    // ============================================
    // SOLUTION CARD PARALLAX
    // ============================================
    const solutionCards = document.querySelectorAll('.solution-card');
    solutionCards.forEach((card, index) => {
        card.style.transitionDelay = (index * 0.05) + 's';
    });

    // ============================================
    // FOOD TABLE ROW HIGHLIGHT
    // ============================================
    document.querySelectorAll('.food-table tbody tr').forEach(row => {
        row.addEventListener('click', function() {
            document.querySelectorAll('.food-table tbody tr').forEach(r => r.style.background = '');
            this.style.background = '#d4edda';
            setTimeout(() => {
                this.style.background = '';
            }, 2000);
        });
    });

    // ============================================
    // SCALE PHASE INTERACTION
    // ============================================
    document.querySelectorAll('.scale-phase').forEach(phase => {
        phase.addEventListener('click', function() {
            document.querySelectorAll('.scale-phase').forEach(p => p.style.transform = '');
            this.style.transform = 'translateY(-12px) scale(1.02)';
        });
    });

    // ============================================
    // REVENUE CARD HOVER CONNECTION
    // ============================================
    document.querySelectorAll('.revenue-card').forEach(card => {
        card.addEventListener('mouseenter', function() {
            this.querySelector('.rev-arrow').style.color = 'var(--primary)';
        });
        card.addEventListener('mouseleave', function() {
            this.querySelector('.rev-arrow').style.color = 'var(--accent)';
        });
    });

    // ============================================
    // PATIENT ROW ACTION BUTTONS
    // ============================================
    document.querySelectorAll('.patient-action').forEach(btn => {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            const row = this.closest('.patient-row');
            row.style.background = 'rgba(32,178,170,0.1)';
            row.style.borderColor = 'var(--accent)';
            this.textContent = 'Reviewed';
            this.style.background = 'var(--accent)';
            this.style.color = 'var(--white)';
            setTimeout(() => {
                row.style.background = '';
                row.style.borderColor = '';
            }, 3000);
        });
    });

    // ============================================
    // KEYBOARD NAVIGATION
    // ============================================
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape' && mobileMenu.classList.contains('active')) {
            mobileMenuBtn.classList.remove('active');
            mobileMenu.classList.remove('active');
            document.body.style.overflow = '';
        }
    });

    // ============================================
    // PREFERS REDUCED MOTION
    // ============================================
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        document.querySelectorAll('.particle').forEach(p => p.style.animation = 'none');
        document.querySelectorAll('.fade-in').forEach(el => el.classList.add('visible'));
    }

    console.log('🚀 Biomexa Pharmaceuticals website loaded successfully!');
});
