"""
================================================================================
BIOMEXAPHARMACEUTICALS - DRUG EFFECTIVENESS & ADHERENCE ANALYSIS SYSTEM
================================================================================
A complete working prototype for calculating drug treatment effectiveness
using patient vitals, adherence data, symptoms, and blood test reports.

Author: BiomexaPharmaceuticals R&D
Version: 1.0.0
Date: 2026-07-22
================================================================================
"""

import pandas as pd
import numpy as np
from datetime import datetime, timedelta
from collections import Counter
import json


# ============================================================
# SECTION 1: DATA MODELS
# ============================================================

class PatientData:
    """
    Core data model for patient tracking across a treatment course.

    Attributes:
        patient_id: Unique patient identifier
        drug_name: Name of the prescribed drug
        drug_dose: Dose amount (e.g., "5mg")
        drug_schedule: List of intake times (e.g., ["08:00", "20:00"])
        baseline: Dict of baseline vital signs
        pre_medical_history: List of pre-existing conditions
        baseline_blood_test: Dict of baseline lab values
        daily_logs: List of daily patient reports
        blood_test_15day: 15-day follow-up blood test results
    """

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
        """
        Add a daily patient log entry.

        Args:
            date: Date string (YYYY-MM-DD)
            adherence_status: 'taken', 'not_taken', or 'remind_later'
            vitals: Dict with bp_systolic, bp_diastolic, glucose, temperature
            symptoms: List of symptom strings
        """
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
        """Add 15-day follow-up blood test results."""
        self.blood_test_15day = blood_test

    def to_dataframe(self):
        """Convert daily logs to pandas DataFrame."""
        return pd.DataFrame(self.daily_logs)


# ============================================================
# SECTION 2: ADHERENCE SCORING ENGINE
# ============================================================

class AdherenceScorer:
    """
    Calculates comprehensive medication adherence metrics.

    Metrics calculated:
    - Adherence rate (%)
    - Dose counts (taken, missed, delayed)
    - Consecutive missed streaks
    - Weekend pattern analysis
    - Timing consistency
    - Risk flags
    """

    def calculate(self, daily_logs, drug_schedule):
        """
        Calculate adherence metrics from daily logs.

        Args:
            daily_logs: List of daily log dicts
            drug_schedule: List of scheduled intake times

        Returns:
            Dict with comprehensive adherence metrics
        """
        total_doses_expected = len(daily_logs) * len(drug_schedule)

        taken_count = sum(1 for log in daily_logs if log['adherence'] == 'taken')
        missed_count = sum(1 for log in daily_logs if log['adherence'] == 'not_taken')
        delayed_count = sum(1 for log in daily_logs if log['adherence'] == 'remind_later')

        # Weighted: taken=1.0, delayed=0.5, missed=0
        weighted_taken = taken_count + (delayed_count * 0.5)
        adherence_rate = (weighted_taken / total_doses_expected) * 100 if total_doses_expected > 0 else 0

        consecutive_missed = self._find_consecutive_missed(daily_logs)

        # Weekend pattern analysis
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
        """Find maximum consecutive missed days."""
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
        """Categorize adherence rate."""
        if rate >= 95: return 'Excellent'
        elif rate >= 80: return 'Good'
        elif rate >= 60: return 'Fair'
        else: return 'Poor'


# ============================================================
# SECTION 3: TREATMENT EFFECTIVENESS ANALYZER
# ============================================================

class EffectivenessAnalyzer:
    """
    Core algorithm to measure drug treatment effectiveness.

    Calculates a composite effectiveness score (0-100) based on:
    - Target achievement (30%)
    - Vital trend direction (30%)
    - Symptom burden (20%)
    - Adherence rate (20%)

    Also generates clinical insights and treatment recommendations.
    """

    def __init__(self, drug_indication):
        """
        Initialize analyzer for a specific indication.

        Args:
            drug_indication: 'hypertension', 'diabetes', 'infection', etc.
        """
        self.indication = drug_indication
        self.targets = self._set_targets()

    def _set_targets(self):
        """Define therapeutic targets based on indication."""
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
        """
        Main effectiveness analysis pipeline.

        Args:
            patient_data: PatientData object
            adherence_report: Output from AdherenceScorer

        Returns:
            Dict with complete effectiveness analysis
        """
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
        """Calculate trend slopes and changes from baseline."""
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
        """Determine if trend is improving, worsening, or stable."""
        threshold = 0.3

        if vital in ['bp_systolic', 'bp_diastolic', 'glucose']:
            if slope < -threshold:
                return 'improving'  # Going down = good
            elif slope > threshold:
                return 'worsening'  # Going up = bad
            else:
                return 'stable'
        elif vital == 'temperature':
            if slope < -threshold:
                return 'improving'
            elif slope > threshold:
                return 'worsening'
            else:
                return 'stable'
        return 'stable'

    def _analyze_symptoms(self, daily_logs):
        """Analyze symptom frequency, severity, and trends."""
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
            if symptom in severe_symptoms:
                severity_score += 3
            elif symptom in moderate_symptoms:
                severity_score += 1

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
        """Calculate how often patient was in therapeutic target range."""
        achievement = {}

        for vital, target_info in self.targets.items():
            values = [log[vital] for log in daily_logs if log[vital] is not None]
            if not values:
                continue

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
        """
        Calculate composite effectiveness score (0-100).

        Weights:
        - Target achievement: 30%
        - Trend direction: 30%
        - Symptom burden: 20%
        - Adherence: 20%
        """
        # 1. Target achievement score
        if target_achievement:
            target_scores = [a['time_in_range_percent'] for a in target_achievement.values()]
            target_score = np.mean(target_scores)
        else:
            target_score = 50

        # 2. Trend score
        trend_scores = []
        for vital, trend_data in trends.items():
            if trend_data['trend_direction'] == 'improving':
                trend_scores.append(90)
            elif trend_data['trend_direction'] == 'stable':
                trend_scores.append(60)
            else:
                trend_scores.append(25)
        trend_score = np.mean(trend_scores) if trend_scores else 50

        # 3. Symptom score
        severity = symptom_analysis['severity_score']
        symptom_score = max(0, 100 - (severity * 8))
        if symptom_analysis['adverse_event_flag']:
            symptom_score = max(0, symptom_score - 25)

        # 4. Adherence score
        adherence_score = adherence_report['adherence_rate']

        # Weighted composite
        effectiveness = (
            target_score * 0.30 +
            trend_score * 0.30 +
            symptom_score * 0.20 +
            adherence_score * 0.20
        )

        return min(100, max(0, effectiveness))

    def _generate_insights(self, trends, target_achievement, symptom_analysis, adherence_report, patient_data):
        """Generate clinical insights for healthcare providers."""
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
        """Generate treatment adjustment recommendations."""
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
        """Compare baseline vs 15-day blood tests."""
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
        """Categorize effectiveness score."""
        if score >= 85: return 'Highly Effective'
        elif score >= 70: return 'Moderately Effective'
        elif score >= 50: return 'Partially Effective'
        elif score >= 30: return 'Minimally Effective'
        else: return 'Not Effective'


# ============================================================
# SECTION 4: REPORT GENERATOR
# ============================================================

class ReportGenerator:
    """Generates formatted reports for patients and doctors."""

    def generate_patient_report(self, result):
        """Generate patient-friendly adherence report."""
        report = f"""
╔══════════════════════════════════════════════════════════════════╗
║           BIOMEXA PHARMACEUTICALS - ADHERENCE REPORT              ║
╚══════════════════════════════════════════════════════════════════╝

Patient ID: {result['patient_id']}
Drug: {result['drug_name']}
Course Duration: {result['course_duration_days']} days

YOUR ADHERENCE SCORE: {result['adherence_summary']['adherence_rate']}%
Category: {result['adherence_summary']['adherence_category']}

Doses Taken: {result['adherence_summary']['doses_taken']}/{result['adherence_summary']['total_expected']}
Doses Missed: {result['adherence_summary']['doses_missed']}

{'⚠️ You missed several doses. Better adherence = better outcomes!' if result['adherence_summary']['risk_flag'] else '✅ Great job staying on track with your medication!'}

Next Steps:
• Continue taking your medication as prescribed
• Set daily reminders if needed
• Contact your doctor if you experience side effects

═══════════════════════════════════════════════════════════════════
        """
        return report

    def generate_doctor_report(self, result):
        """Generate clinical report for healthcare providers."""
        report = f"""
╔══════════════════════════════════════════════════════════════════╗
║      BIOMEXA PHARMACEUTICALS - TREATMENT EFFECTIVENESS REPORT     ║
╚══════════════════════════════════════════════════════════════════╝

Patient ID: {result['patient_id']}
Drug: {result['drug_name']}
Course Duration: {result['course_duration_days']} days

EFFECTIVENESS SCORE: {result['effectiveness_score']}/100
Category: {result['effectiveness_category']}

ADHERENCE SUMMARY:
  Rate: {result['adherence_summary']['adherence_rate']}%
  Taken: {result['adherence_summary']['doses_taken']}/{result['adherence_summary']['total_expected']}
  Risk Flag: {'YES' if result['adherence_summary']['risk_flag'] else 'NO'}

VITAL TRENDS:
"""
        for vital, trend in result['vital_trends'].items():
            report += f"  {vital.replace('_', ' ').upper()}: {trend['baseline_value']} → {trend['latest_value']} ({trend['trend_direction']})\n"

        report += "\nCLINICAL INSIGHTS:\n"
        for i, insight in enumerate(result['clinical_insights'], 1):
            report += f"  {i}. {insight}\n"

        report += "\nRECOMMENDATIONS:\n"
        for i, rec in enumerate(result['treatment_recommendations'], 1):
            report += f"  {i}. {rec}\n"

        report += "\n═══════════════════════════════════════════════════════════════════"
        return report


# ============================================================
# SECTION 5: DEMONSTRATION
# ============================================================

def demo():
    """Run a complete demonstration of the system."""
    print("=" * 70)
    print("BIOMEXAPHARMACEUTICALS - DRUG EFFECTIVENESS ANALYSIS DEMO")
    print("=" * 70)

    # Create sample patient
    patient = PatientData(
        patient_id="BP-2026-001",
        drug_name="Amlodipine",
        drug_dose="5mg",
        drug_schedule=["08:00"],
        baseline_bp=(165, 105),
        baseline_glucose=110,
        baseline_temp=98.6,
        pre_medical_history=["hypertension", "prediabetes"],
        baseline_blood_test={
            'creatinine': 1.0,
            'alt': 25,
            'ast': 22,
            'wbc': 7500,
            'hemoglobin': 14.2,
            'platelets': 250000
        }
    )

    # Simulate 15 days
    np.random.seed(42)
    for day in range(15):
        date = (datetime(2026, 7, 1) + timedelta(days=day)).strftime("%Y-%m-%d")
        adherence = np.random.choice(
            ['taken', 'taken', 'taken', 'taken', 'taken', 'taken', 'taken', 'taken', 'taken', 'not_taken'],
            p=[0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1]
        )

        bp_sys = 165 - (day * 2.5) + np.random.normal(0, 3)
        bp_dia = 105 - (day * 1.5) + np.random.normal(0, 2)
        glucose = 110 + np.random.normal(0, 5)
        temp = 98.6 + np.random.normal(0, 0.2)

        symptoms = []
        if day < 3:
            symptoms = ['mild_headache', 'dizziness']
        elif day < 7:
            symptoms = ['mild_headache']

        patient.add_daily_log(
            date=date,
            adherence_status=adherence,
            vitals={
                'bp_systolic': round(bp_sys, 1),
                'bp_diastolic': round(bp_dia, 1),
                'glucose': round(glucose, 1),
                'temperature': round(temp, 1)
            },
            symptoms=symptoms
        )

    patient.add_15day_blood_test({
        'creatinine': 1.05,
        'alt': 28,
        'ast': 24,
        'wbc': 7200,
        'hemoglobin': 14.0,
        'platelets': 245000
    })

    # Run analysis
    adherence_scorer = AdherenceScorer()
    adherence_report = adherence_scorer.calculate(patient.daily_logs, patient.drug_schedule)

    effectiveness_analyzer = EffectivenessAnalyzer(drug_indication='hypertension')
    result = effectiveness_analyzer.analyze(patient, adherence_report)

    # Generate reports
    report_gen = ReportGenerator()
    patient_report = report_gen.generate_patient_report(result)
    doctor_report = report_gen.generate_doctor_report(result)

    print(patient_report)
    print(doctor_report)

    # Export to JSON
    with open('effectiveness_result.json', 'w') as f:
        json.dump(result, f, indent=2, default=str)
    print("\n✅ Result exported to effectiveness_result.json")

    return result


if __name__ == "__main__":
    demo()
