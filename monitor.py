import os
import json
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
import urllib.request
from datetime import datetime, timedelta
import yfinance as yf
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

DATA_URL = "https://raw.githubusercontent.com/kadoa-org/congress-trading-monitor/main/public/data/trades.json"
ALERTS_FILE = "alerts.json"
HISTORY_FILE = "alert_history.json"

def get_stock_prices(ticker, trade_date_str):
    """
    Fetches the closing price on the transaction date and the current live price.
    Gracefully handles weekends and holidays by looking for the closest trading date.
    """
    try:
        t = yf.Ticker(ticker)
        trade_date = datetime.strptime(trade_date_str, "%Y-%m-%d")
        
        # Fetch a 5-day window to cover weekends and holiday gaps
        start_date = trade_date - timedelta(days=2)
        end_date = trade_date + timedelta(days=3)
        hist = t.history(start=start_date.strftime("%Y-%m-%d"), end=end_date.strftime("%Y-%m-%d"))
        
        if hist.empty:
            return None, None
            
        # Find the index closest to the trade date
        hist['date_diff'] = [abs((idx.to_pydatetime().replace(tzinfo=None) - trade_date).days) for idx in hist.index]
        closest_row = hist.loc[hist['date_diff'].idxmin()]
        hist_price = float(closest_row['Close'])
        
        # Get live price
        current_price = None
        if hasattr(t, 'basic_info') and 'lastPrice' in t.basic_info and t.basic_info['lastPrice'] is not None:
            current_price = float(t.basic_info['lastPrice'])
        else:
            recent = t.history(period="1d")
            if not recent.empty:
                current_price = float(recent['Close'].iloc[-1])
                
        return hist_price, current_price
    except Exception as e:
        print(f"[{ticker}] Price fetch exception: {e}")
        return None, None

def send_email_alert(trade, hist_price, current_price, alert_type):
    """
    Sends an email alert using Gmail SMTP.
    """
    sender = os.getenv("SENDER_EMAIL")
    password = os.getenv("SENDER_PASSWORD")
    receiver = os.getenv("RECEIVER_EMAIL")
    
    if not sender or not password or not receiver or "your-gmail" in sender:
        print("SMTP credentials not configured. Skipping email alert.")
        return False
        
    try:
        msg = MIMEMultipart()
        msg['From'] = sender
        msg['To'] = receiver
        
        diff_pct = abs((current_price - hist_price) / hist_price) * 100
        
        if alert_type == "BUY_OPPORTUNITY":
            msg['Subject'] = f"🚨 CONGRESS TRADE RADAR: BUY OPPORTUNITY - {trade['ticker']}"
            body = f"""
            <h3>Congress Trade Radar Alert</h3>
            <p><strong>Filer:</strong> {trade['filer_name']} ({trade['chamber'].upper() if trade['chamber'] else 'Executive'} - {trade['party'] or ''})</p>
            <p><strong>Stock:</strong> {trade['ticker']} - {trade['asset_name']}</p>
            <p><strong>Politician Purchase Date:</strong> {trade['transaction_date']} @ Est. <strong>${hist_price:.2f}</strong></p>
            <p><strong>Current Stock Price:</strong> <strong>${current_price:.2f}</strong> (<span style="color: green;">-{diff_pct:.1f}% lower</span> than entry!)</p>
            <p><strong>Estimated Trade Size:</strong> {trade['amount_range_label']}</p>
            <br>
            <p><a href="{trade['doc_url']}">View Official Disclosure PDF</a></p>
            """
        else:
            msg['Subject'] = f"🚨 CONGRESS TRADE RADAR: SELL HIT - {trade['ticker']}"
            body = f"""
            <h3>Congress Trade Radar Alert</h3>
            <p><strong>Filer:</strong> {trade['filer_name']} ({trade['chamber'].upper() if trade['chamber'] else 'Executive'} - {trade['party'] or ''})</p>
            <p><strong>Stock:</strong> {trade['ticker']} - {trade['asset_name']}</p>
            <p><strong>Politician Sale Date:</strong> {trade['transaction_date']} @ Est. <strong>${hist_price:.2f}</strong></p>
            <p><strong>Current Stock Price:</strong> <strong>${current_price:.2f}</strong> (<span style="color: red;">+{diff_pct:.1f}% higher</span> than exit!)</p>
            <p><strong>Estimated Trade Size:</strong> {trade['amount_range_label']}</p>
            <br>
            <p><a href="{trade['doc_url']}">View Official Disclosure PDF</a></p>
            """
            
        msg.attach(MIMEText(body, 'html'))
        
        # Connect to Gmail SMTP server
        with smtplib.SMTP("smtp.gmail.com", 587) as server:
            server.starttls()
            server.login(sender, password)
            server.sendmail(sender, [receiver], msg.as_string())
            
        print(f"Email alert sent successfully for {trade['ticker']}")
        return True
    except Exception as e:
        print(f"Failed to send email alert: {e}")
        return False

def run_monitor():
    print(f"[{datetime.now().isoformat()}] Starting trade price monitor...")
    
    # 1. Load alerts, history, and raw data
    active_alerts = []
    if os.path.exists(ALERTS_FILE):
        try:
            with open(ALERTS_FILE, 'r') as f:
                active_alerts = json.load(f)
        except Exception:
            pass
            
    history = {}
    if os.path.exists(HISTORY_FILE):
        try:
            with open(HISTORY_FILE, 'r') as f:
                history = json.load(f)
        except Exception:
            pass

    try:
        req = urllib.request.Request(DATA_URL, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req) as res:
            all_trades = json.loads(res.read().decode('utf-8'))
    except Exception as e:
        print(f"Failed to retrieve disclosures: {e}")
        return

    # Filter trades: Only process the latest 100 trades to limit yfinance traffic, and check history
    unprocessed_trades = []
    for trade in all_trades[:100]:
        t_id = trade.get('id')
        if not t_id or t_id in history:
            continue
        ticker = trade.get('ticker')
        if not ticker or ticker == "--":
            continue
        unprocessed_trades.append(trade)

    print(f"Found {len(unprocessed_trades)} new transactions to evaluate.")

    new_alerts = []
    for trade in unprocessed_trades:
        ticker = trade['ticker']
        t_date = trade['transaction_date']
        t_type = (trade['transaction_type'] or '').lower()
        t_id = trade['id']
        
        print(f"Evaluating {ticker} traded by {trade['filer_name']} on {t_date}...")
        
        hist_price, current_price = get_stock_prices(ticker, t_date)
        if hist_price is None or current_price is None:
            # Mark as processed with failure so we don't block subsequent runs or query repeatedly
            history[t_id] = {
                "status": "failed",
                "processed_at": datetime.now().isoformat(),
                "reason": "price_fetch_failed"
            }
            continue
            
        alert_type = None
        # Condition 1: Buy order and current price is lower
        if "purchase" in t_type and current_price < hist_price:
            alert_type = "BUY_OPPORTUNITY"
        # Condition 2: Sell order and current price is higher
        elif "sale" in t_type and current_price > hist_price:
            alert_type = "SELL_HIT"

        if alert_type:
            diff_pct = ((current_price - hist_price) / hist_price) * 100
            alert_obj = {
                "id": t_id,
                "ticker": ticker,
                "filer_name": trade['filer_name'],
                "party": trade['party'],
                "state": trade['state'],
                "chamber": trade['chamber'],
                "transaction_type": trade['transaction_type'],
                "transaction_date": t_date,
                "amount_range_label": trade['amount_range_label'],
                "hist_price": hist_price,
                "current_price": current_price,
                "diff_pct": diff_pct,
                "alert_type": alert_type,
                "doc_url": trade['doc_url'],
                "timestamp": datetime.now().isoformat()
            }
            
            # Send Email
            email_sent = send_email_alert(trade, hist_price, current_price, alert_type)
            alert_obj["email_sent"] = email_sent
            
            new_alerts.append(alert_obj)
            active_alerts.insert(0, alert_obj) # Add to top of list
            
            print(f"[ALERT] {alert_type} triggered for {ticker}! ({diff_pct:.1f}%)")
            
        # Record history
        history[t_id] = {
            "status": "processed",
            "processed_at": datetime.now().isoformat(),
            "alert_triggered": alert_type is not None
        }

    # Save outputs
    if new_alerts:
        # Keep only the latest 100 active alerts to prevent alerts.json growing too large
        active_alerts = active_alerts[:100]
        with open(ALERTS_FILE, 'w') as f:
            json.dump(active_alerts, f, indent=4)
            
    with open(HISTORY_FILE, 'w') as f:
        json.dump(history, f, indent=4)
        
    print(f"[{datetime.now().isoformat()}] Monitor pass complete. Generated {len(new_alerts)} new alerts.")

if __name__ == "__main__":
    run_monitor()
