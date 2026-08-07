"""
================================================================================
BIOMEXA AI ENGINE - Flask API for Drug Effectiveness Analysis
================================================================================
This file runs as a separate service that your Node.js backend calls.
It analyzes patient vitals, adherence, and symptoms to calculate:
- Effectiveness Score (0-100)
- Risk Label (Low / Moderate / High / Critical)
- Clinical Insights
- Treatment Recommendations
================================================================================
"""

from flask import Flask, request, jsonify
from flask_cors import CORS
import pandas as pd
import numpy as np
from datetime import datetime, timedelta
from collections import Counter
import json

app = Flask(__name__)
CORS(app)

# ============================================================
# SECTION 1: DATA MODELS
# ============================================================

class PatientData:
    def __init__(self, patient_id, drug_name, drug_dose, drug_schedule, 
                 baseline_bp, baseline_glucose, baseline_temp,
                 pre_medical_history, baseline_blood_test):
        self.patient_id = patient_id
        self.drug_name = drug_name
        self.drug_dose = drug_dose
        self.drug_schedule = drug_schedule
        self.baseline = {
            'bp_systolic': baseline_bp[0],
            'bp_diastolic': baseline_bp[1],
            'glucose': baseline_glucose,
            'temperature': baseline_temp
        }
        self.pre_medical_history = pre_medical_history
        self.baseline_blood_test = baseline_blood_test
        self.daily_logs = []
        self.blood_test_15day = None

    def add_daily_log(self, date, adherence_status, vitals, symptoms):
        self.daily_logs.append({
            'date': date,
            'adherence': adherence_status,
            'bp_systolic': vitals.get('bp_systolic'),
            'bp_diastolic': vitals.get('bp_diastolic'),
            'glucose': vitals.get('glucose'),
            'temperature': vitals.get('temperature'),
            'symptoms': symptoms
        })

    def add_15day_blood_test(self, blood_test):
        self.blood_test_15day = blood_test

# ============================================================
# SECTION 2: ADHERENCE SCORING ENGINE
# ============================================================

class AdherenceScorer:
    def calculate(self, daily_logs, drug_schedule):
        total_doses_expected = len(daily_logs) * len(drug_schedule)
        taken_count = sum(1 for log in daily_logs if log['adherence'] == 'taken')
        missed_count = sum(1 for log in daily_logs if log['adherence'] == 'not_taken')
        delayed_count = sum(1 for log in daily_logs if log['adherence'] == 'remind_later')

        weighted_taken = taken_count + (delayed_count * 0.5)
        adherence_rate = (weighted_taken / total_doses_expected) * 100 if total_doses_expected > 0 else 0

        consecutive_missed = self._find_consecutive_missed(daily_logs)

        weekend_misses = sum(1 for log in daily_logs 
                           if log['adherence'] == 'not_taken' 
                           and datetime.strptime(log['date'], "%Y-%m-%d").weekday() >= 5)

        return {
            'adherence_rate': round(adherence_rate, 2),
            'doses_taken': taken_count,
            'doses_missed': missed_count,
            'doses_delayed': delayed_count,
            'total_expected': total_doses_expected,
            'consecutive_missed_streak': consecutive_missed,
            'weekend_misses': weekend_misses,
            'adherence_category': self._categorize(adherence_rate),
            'risk_flag': adherence_rate < 80,
            'intervention_needed': adherence_rate < 70 or consecutive_missed >= 2
        }

    def _find_consecutive_missed(self, daily_logs):
        max_streak = 0
        current_streak = 0
        for log in daily_logs:
            if log['adherence'] == 'not_taken':
                current_streak += 1
                max_streak = max(max_streak, current_streak)
            else:
                current_streak = 0
        return max_streak

    def _categorize(self, rate):
        if rate >= 95: return 'Excellent'
        elif rate >= 80: return 'Good'
        elif rate >= 60: return 'Fair'
        else: return 'Poor'

# ============================================================
# SECTION 3: TREATMENT EFFECTIVENESS ANALYZER
# ============================================================

class EffectivenessAnalyzer:
    def __init__(self, drug_indication):
        self.indication = drug_indication
        self.targets = self._set_targets()

    def _set_targets(self):
        targets = {
            'hypertension': {
                'bp_systolic': {'target': 130, 'acceptable_range': [120, 140]},
                'bp_diastolic': {'target': 85, 'acceptable_range': [80, 90]}
            },
            'diabetes': {
                'glucose': {'target': 140, 'acceptable_range': [80, 180]}
            },
            'infection': {
                'temperature': {'target': 98.6, 'acceptable_range': [97, 99.5]}
            }
        }
        return targets.get(self.indication, {})

    def analyze(self, patient_data, adherence_report):
        daily_logs = patient_data.daily_logs
        baseline = patient_data.baseline

        if len(daily_logs) == 0:
            return {"error": "No daily data available"}

        trends = self._calculate_trends(daily_logs, baseline)
        symptom_analysis = self._analyze_symptoms(daily_logs)
        target_achievement = self._calculate_target_achievement(daily_logs)
        effectiveness_score = self._calculate_effectiveness_score(
            trends, target_achievement, symptom_analysis, adherence_report
        )
        insights = self._generate_insights(
            trends, target_achievement, symptom_analysis, adherence_report, patient_data
        )
        recommendations = self._generate_recommendations(
            effectiveness_score, trends, adherence_report, patient_data
        )

        return {
            'patient_id': patient_data.patient_id,
            'drug_name': patient_data.drug_name,
            'course_duration_days': len(daily_logs),
            'effectiveness_score': round(effectiveness_score, 2),
            'effectiveness_category': self._categorize_effectiveness(effectiveness_score),
            'adherence_summary': adherence_report,
            'vital_trends': trends,
            'target_achievement': target_achievement,
            'symptom_analysis': symptom_analysis,
            'clinical_insights': insights,
            'treatment_recommendations': recommendations,
            'blood_test_comparison': self._compare_blood_tests(patient_data)
        }

    def _calculate_trends(self, daily_logs, baseline):
        results = {}
        vitals_to_track = ['bp_systolic', 'bp_diastolic', 'glucose', 'temperature']

        for vital in vitals_to_track:
            values = [log[vital] for log in daily_logs if log[vital] is not None]
            if len(values) >= 2:
                x = np.arange(len(values))
                slope = np.polyfit(x, values, 1)[0]

                baseline_val = baseline.get(vital)
                if baseline_val:
                    pct_change = ((values[-1] - baseline_val) / baseline_val) * 100
                    absolute_change = values[-1] - baseline_val
                else:
                    pct_change = 0
                    absolute_change = 0

                cv = (np.std(values) / np.mean(values)) * 100 if np.mean(values) != 0 else 0
                avg_value = np.mean(values)

                trend_dir = self._get_trend_direction(vital, slope, absolute_change)

                results[vital] = {
                    'slope_per_day': round(slope, 4),
                    'trend_direction': trend_dir,
                    'baseline_value': baseline_val,
                    'latest_value': round(values[-1], 2),
                    'average_value': round(avg_value, 2),
                    'absolute_change': round(absolute_change, 2),
                    'percent_change': round(pct_change, 2),
                    'variability_cv': round(cv, 2),
                    'min_value': round(min(values), 2),
                    'max_value': round(max(values), 2)
                }

        return results

    def _get_trend_direction(self, vital, slope, absolute_change):
        threshold = 0.3
        if vital in ['bp_systolic', 'bp_diastolic', 'glucose']:
            if slope < -threshold: return 'improving'
            elif slope > threshold: return 'worsening'
            else: return 'stable'
        elif vital == 'temperature':
            if slope < -threshold: return 'improving'
            elif slope > threshold: return 'worsening'
            else: return 'stable'
        return 'stable'

    def _analyze_symptoms(self, daily_logs):
        all_symptoms = []
        symptom_by_day = {}

        for log in daily_logs:
            day_symptoms = log.get('symptoms', [])
            symptom_by_day[log['date']] = day_symptoms
            all_symptoms.extend(day_symptoms)

        symptom_freq = Counter(all_symptoms)

        severe_symptoms = ['chest_pain', 'difficulty_breathing', 'severe_headache', 
                          'fainting', 'severe_rash', 'swelling', 'anaphylaxis']
        moderate_symptoms = ['nausea', 'dizziness', 'fatigue', 'mild_rash', 
                            'stomach_pain', 'insomnia', 'dry_cough']

        severity_score = 0
        for symptom in all_symptoms:
            if symptom in severe_symptoms: severity_score += 3
            elif symptom in moderate_symptoms: severity_score += 1

        early_days = list(symptom_by_day.keys())[:5]
        late_days = list(symptom_by_day.keys())[-5:]
        early_symptoms = sum(len(symptom_by_day.get(d, [])) for d in early_days)
        late_symptoms = sum(len(symptom_by_day.get(d, [])) for d in late_days)

        symptom_trend = 'decreasing' if late_symptoms < early_symptoms else 'increasing' if late_symptoms > early_symptoms else 'stable'

        return {
            'total_symptom_reports': len(all_symptoms),
            'unique_symptoms': list(symptom_freq.keys()),
            'symptom_frequency': dict(symptom_freq),
            'severity_score': severity_score,
            'symptom_trend': symptom_trend,
            'adverse_event_flag': any(s in severe_symptoms for s in all_symptoms),
            'early_vs_late_ratio': round(early_symptoms / max(late_symptoms, 1), 2)
        }

    def _calculate_target_achievement(self, daily_logs):
        achievement = {}
        for vital, target_info in self.targets.items():
            values = [log[vital] for log in daily_logs if log[vital] is not None]
            if not values: continue

            target = target_info['target']
            low, high = target_info['acceptable_range']

            in_range_count = sum(1 for v in values if low <= v <= high)
            in_range_pct = (in_range_count / len(values)) * 100

            first_in_range = next((i for i, v in enumerate(values) if low <= v <= high), None)

            achievement[vital] = {
                'target_value': target,
                'acceptable_range': [low, high],
                'time_in_range_percent': round(in_range_pct, 2),
                'days_to_first_in_range': first_in_range + 1 if first_in_range is not None else None,
                'average_deviation_from_target': round(np.mean([abs(v - target) for v in values]), 2)
            }

        return achievement

    def _calculate_effectiveness_score(self, trends, target_achievement, symptom_analysis, adherence_report):
        if target_achievement:
            target_scores = [a['time_in_range_percent'] for a in target_achievement.values()]
            target_score = np.mean(target_scores)
        else:
            target_score = 50

        trend_scores = []
        for vital, trend_data in trends.items():
            if trend_data['trend_direction'] == 'improving': trend_scores.append(90)
            elif trend_data['trend_direction'] == 'stable': trend_scores.append(60)
            else: trend_scores.append(25)
        trend_score = np.mean(trend_scores) if trend_scores else 50

        severity = symptom_analysis['severity_score']
        symptom_score = max(0, 100 - (severity * 8))
        if symptom_analysis['adverse_event_flag']:
            symptom_score = max(0, symptom_score - 25)

        adherence_score = adherence_report['adherence_rate']

        effectiveness = (
            target_score * 0.30 +
            trend_score * 0.30 +
            symptom_score * 0.20 +
            adherence_score * 0.20
        )

        return min(100, max(0, effectiveness))

    def _generate_insights(self, trends, target_achievement, symptom_analysis, adherence_report, patient_data):
        insights = []

        if adherence_report['adherence_rate'] < 80:
            insights.append(f"LOW ADHERENCE ({adherence_report['adherence_rate']}%): May be masking true drug effectiveness. Address before changing therapy.")
        elif adherence_report['adherence_rate'] > 95:
            insights.append(f"EXCELLENT ADHERENCE ({adherence_report['adherence_rate']}%): Reliable effectiveness assessment.")

        for vital, trend in trends.items():
            vital_name = vital.replace('_', ' ').upper()
            if trend['trend_direction'] == 'improving':
                insights.append(f"IMPROVING {vital_name}: {trend['percent_change']}% change from baseline. Drug effective for this parameter.")
            elif trend['trend_direction'] == 'worsening' and abs(trend['percent_change']) > 5:
                insights.append(f"WORSENING {vital_name}: {trend['percent_change']}% change from baseline. Consider dose adjustment or add-on therapy.")

        for vital, achievement in target_achievement.items():
            vital_name = vital.replace('_', ' ').upper()
            if achievement['time_in_range_percent'] < 50:
                insights.append(f"POOR CONTROL ({vital_name}): In range only {achievement['time_in_range_percent']}% of time. Dose escalation or combination therapy warranted.")
            elif achievement['time_in_range_percent'] > 80:
                insights.append(f"GOOD CONTROL ({vital_name}): In range {achievement['time_in_range_percent']}% of time.")

        if symptom_analysis['adverse_event_flag']:
            insights.append("ADVERSE EVENTS: Severe symptoms reported. Evaluate for drug discontinuation.")
        if symptom_analysis['symptom_trend'] == 'increasing':
            insights.append("INCREASING SYMPTOMS: Burden growing over time. May indicate intolerance.")
        elif symptom_analysis['symptom_trend'] == 'decreasing':
            insights.append("DECREASING SYMPTOMS: Good tolerability profile emerging.")

        for vital, trend in trends.items():
            if trend['variability_cv'] > 15:
                insights.append(f"HIGH VARIABILITY ({vital.replace('_', ' ').upper()}): CV={trend['variability_cv']}%. Consider timing standardization.")

        return insights

    def _generate_recommendations(self, effectiveness_score, trends, adherence_report, patient_data):
        recommendations = []

        if effectiveness_score >= 80:
            recommendations.append("CONTINUE: Drug is highly effective. Maintain current regimen.")
        elif effectiveness_score >= 60:
            recommendations.append("OPTIMIZE: Partial response. Consider dose escalation or adherence reinforcement.")
        else:
            recommendations.append("REASSESS: Limited effectiveness. Evaluate alternative therapy or combination approach.")

        if adherence_report['intervention_needed']:
            recommendations.append("ADHERENCE PROGRAM: Deploy enhanced reminders, pill packaging, or caregiver alerts.")

        for vital, trend in trends.items():
            if trend['trend_direction'] == 'worsening':
                if vital == 'bp_systolic' and trend['latest_value'] > 140:
                    recommendations.append(f"BP CONTROL: Current {trend['latest_value']} mmHg. Consider dose increase or add ARB/ACE-i.")
                elif vital == 'glucose' and trend['latest_value'] > 180:
                    recommendations.append(f"GLYCEMIC CONTROL: Current {trend['latest_value']} mg/dL. Consider dose increase or add metformin.")

        if patient_data.blood_test_15day:
            recommendations.append("REVIEW LABS: Check renal function, liver enzymes, and drug-specific safety markers.")

        return recommendations

    def _compare_blood_tests(self, patient_data):
        if not patient_data.blood_test_15day or not patient_data.baseline_blood_test:
            return {"available": False}

        comparison = {"available": True, "parameters": {}}

        for param in ['creatinine', 'alt', 'ast', 'wbc', 'hemoglobin', 'platelets']:
            baseline_val = patient_data.baseline_blood_test.get(param)
            day15_val = patient_data.blood_test_15day.get(param)

            if baseline_val and day15_val:
                pct_change = ((day15_val - baseline_val) / baseline_val) * 100
                comparison["parameters"][param] = {
                    'baseline': baseline_val,
                    'day15': day15_val,
                    'percent_change': round(pct_change, 2),
                    'flag': 'significant' if abs(pct_change) > 20 else 'stable'
                }

        return comparison

    def _categorize_effectiveness(self, score):
        if score >= 85: return 'Highly Effective'
        elif score >= 70: return 'Moderately Effective'
        elif score >= 50: return 'Partially Effective'
        elif score >= 30: return 'Minimally Effective'
        else: return 'Not Effective'


# ============================================================
# SECTION 4: RISK CALCULATOR
# ============================================================

def calculate_risk_label(effectiveness_score, adherence_rate, adverse_events):
    """Simple risk stratification for dashboard display."""
    if adverse_events and effectiveness_score < 50:
        return {"label": "CRITICAL", "color": "#ef4444", "priority": 1}
    elif effectiveness_score < 40 or adherence_rate < 50:
        return {"label": "HIGH RISK", "color": "#f39c12", "priority": 2}
    elif effectiveness_score < 65 or adherence_rate < 75:
        return {"label": "MODERATE", "color": "#fbbf24", "priority": 3}
    else:
        return {"label": "LOW RISK", "color": "#10b981", "priority": 4}


# ============================================================
# SECTION 5: API ENDPOINTS
# ============================================================

@app.route('/health', methods=['GET'])
def health():
    return jsonify({"status": "AI Engine OK", "timestamp": datetime.now().isoformat()})

@app.route('/analyze', methods=['POST'])
def analyze():
    """
    Main analysis endpoint.
    Expects JSON with patient data, daily logs, and dose history.
    Returns effectiveness score, risk label, insights, and recommendations.
    """
    try:
        data = request.get_json()

        # Extract patient info
        patient_info = data.get('patient', {})
        daily_logs_raw = data.get('daily_logs', [])
        dose_history = data.get('dose_history', [])
        indication = data.get('indication', 'hypertension')

        # Build patient data object
        patient = PatientData(
            patient_id=patient_info.get('id', 'unknown'),
            drug_name=patient_info.get('drug_name', 'Unknown Drug'),
            drug_dose=patient_info.get('drug_dose', '5mg'),
            drug_schedule=patient_info.get('schedule', ['08:00']),
            baseline_bp=patient_info.get('baseline_bp', [140, 90]),
            baseline_glucose=patient_info.get('baseline_glucose', 110),
            baseline_temp=patient_info.get('baseline_temp', 98.6),
            pre_medical_history=patient_info.get('history', []),
            baseline_blood_test=patient_info.get('baseline_blood_test', {})
        )

        # Convert dose history to daily logs format
        for dose in dose_history:
            patient.add_daily_log(
                date=dose.get('date', datetime.now().strftime('%Y-%m-%d')),
                adherence_status=dose.get('status', 'taken'),
                vitals=dose.get('vitals', {}),
                symptoms=dose.get('symptoms', [])
            )

        # Run analysis
        scorer = AdherenceScorer()
        adherence = scorer.calculate(patient.daily_logs, patient.drug_schedule)

        analyzer = EffectivenessAnalyzer(drug_indication=indication)
        result = analyzer.analyze(patient, adherence)

        # Add risk label
        risk = calculate_risk_label(
            result['effectiveness_score'],
            adherence['adherence_rate'],
            result['symptom_analysis']['adverse_event_flag']
        )
        result['risk_label'] = risk

        # Simplified dashboard data
        dashboard_data = {
            'effectiveness_score': result['effectiveness_score'],
            'effectiveness_category': result['effectiveness_category'],
            'risk_label': risk,
            'adherence_rate': adherence['adherence_rate'],
            'adherence_category': adherence['adherence_category'],
            'doses_taken': adherence['doses_taken'],
            'doses_missed': adherence['doses_missed'],
            'intervention_needed': adherence['intervention_needed'],
            'top_insights': result['clinical_insights'][:3],
            'top_recommendations': result['treatment_recommendations'][:3],
            'symptom_trend': result['symptom_analysis']['symptom_trend'],
            'adverse_event_flag': result['symptom_analysis']['adverse_event_flag'],
            'vital_summary': {
                k: {
                    'trend': v['trend_direction'],
                    'latest': v['latest_value'],
                    'change': v['percent_change']
                }
                for k, v in result['vital_trends'].items()
            }
        }

        return jsonify({
            "success": True,
            "full_report": result,
            "dashboard": dashboard_data
        })

    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route('/quick-risk', methods=['POST'])
def quick_risk():
    """
    Quick risk assessment from basic stats.
    Expects: { adherence_rate, missed_doses, symptoms_count }
    """
    try:
        data = request.get_json()
        adherence = data.get('adherence_rate', 100)
        missed = data.get('missed_doses', 0)
        symptoms = data.get('symptoms_count', 0)

        # Simple heuristic
        score = 100
        score -= (100 - adherence) * 0.5
        score -= missed * 3
        score -= symptoms * 2
        score = max(0, min(100, score))

        risk = calculate_risk_label(score, adherence, symptoms > 5)

        return jsonify({
            "success": True,
            "effectiveness_score": round(score, 1),
            "risk_label": risk,
            "adherence_rate": adherence
        })

    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


# ============================================================
# START SERVER
# ============================================================

if __name__ == '__main__':
    print("🧠 Biomexa AI Engine starting on port 5001...")
    print("📊 Endpoints:")
    print("   POST /analyze       - Full effectiveness analysis")
    print("   POST /quick-risk    - Quick risk assessment")
    print("   GET  /health        - Health check")
    app.run(host='0.0.0.0', port=5001, debug=False)