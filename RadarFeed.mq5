//+------------------------------------------------------------------+
//| RadarFeed.mq5                                                    |
//| Sends live prices from MT5 to your Forex Radar dashboard.        |
//| ALERTS ONLY: this program never places, changes or closes trades.|
//|                                                                  |
//| Setup (once):                                                    |
//| 1. Tools > Options > Expert Advisors > tick "Allow WebRequest"   |
//|    and add BOTH addresses:                                       |
//|      https://identitytoolkit.googleapis.com                      |
//|      https://loyalty-fx-default-rtdb.firebaseio.com              |
//| 2. Drag this program onto any chart, open the Inputs tab, enter  |
//|    FeedEmail and FeedPassword (the dedicated feed user you made  |
//|    in Firebase), tick "Allow Algo Trading", press OK.            |
//| 3. Experts tab should say "signed in to Firebase" and then       |
//|    "live data is flowing".                                       |
//+------------------------------------------------------------------+
#property copyright "Forex Radar"
#property version   "1.00"

input string FirebaseApiKey = "AIzaSyCKACM1fsSOqTiRfCc10Lr0f2oaLEv2k-Q";
input string DatabaseUrl    = "https://loyalty-fx-default-rtdb.firebaseio.com";
input string FeedEmail      = "";
input string FeedPassword   = "";
input string Pairs          = "EURUSD,GBPUSD,USDJPY,AUDUSD,USDCAD,XAUUSD";
input string SymbolSuffix   = "";    // some brokers add a suffix, for example ".m" or "pro"
input int    TickEverySec   = 2;
input int    BarsEverySec   = 60;
input int    BarsCount      = 60;

string   g_syms[];
string   g_names[];
int      g_n = 0;
string   g_token = "";
datetime g_loginAt = 0;
datetime g_retryAt = 0;
datetime g_lastTick = 0;
datetime g_lastBars = 0;
bool     g_okLogged = false;

//--- helpers ------------------------------------------------------
string JsonEsc(const string s)
{
   string r = s;
   StringReplace(r, "\\", "\\\\");
   StringReplace(r, "\"", "\\\"");
   return r;
}

string JsonString(const string json, const string key)
{
   string pat = "\"" + key + "\"";
   int p = StringFind(json, pat);
   if(p < 0) return "";
   p = StringFind(json, ":", p + StringLen(pat));
   if(p < 0) return "";
   int q1 = StringFind(json, "\"", p + 1);
   if(q1 < 0) return "";
   int q2 = StringFind(json, "\"", q1 + 1);
   if(q2 < 0) return "";
   return StringSubstr(json, q1 + 1, q2 - q1 - 1);
}

int Post(const string url, const string body, string &resp)
{
   char data[];
   char result[];
   string rh = "";
   int n = StringToCharArray(body, data, 0, WHOLE_ARRAY, CP_UTF8);
   if(n > 0) ArrayResize(data, n - 1);   // drop the trailing zero
   ResetLastError();
   int code = WebRequest("POST", url, "Content-Type: application/json\r\n", 10000, data, result, rh);
   if(code == -1)
   {
      Print("RadarFeed: WebRequest error ", GetLastError(),
            ". If it is 4060, add the address under Tools > Options > Expert Advisors > Allow WebRequest.");
      return -1;
   }
   resp = CharArrayToString(result, 0, ArraySize(result), CP_UTF8);
   return code;
}

bool Login()
{
   string url  = "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=" + FirebaseApiKey;
   string body = "{\"email\":\"" + JsonEsc(FeedEmail) + "\",\"password\":\"" + JsonEsc(FeedPassword) + "\",\"returnSecureToken\":true}";
   string resp = "";
   int code = Post(url, body, resp);
   if(code != 200)
   {
      if(code != -1) Print("RadarFeed: sign-in failed (HTTP ", code, "): ", resp);
      g_token = "";
      g_retryAt = TimeLocal() + 20;
      return false;
   }
   string tok = JsonString(resp, "idToken");
   if(tok == "")
   {
      Print("RadarFeed: sign-in reply had no token.");
      g_retryAt = TimeLocal() + 20;
      return false;
   }
   g_token = tok;
   g_loginAt = TimeLocal();
   Print("RadarFeed: signed in to Firebase as ", FeedEmail);
   return true;
}

bool Put(const string path, const string json)
{
   string url = DatabaseUrl + "/" + path + ".json?auth=" + g_token + "&x-http-method-override=PUT";
   string resp = "";
   int code = Post(url, json, resp);
   if(code == 200)
   {
      if(!g_okLogged) { Print("RadarFeed: live data is flowing to Firebase."); g_okLogged = true; }
      return true;
   }
   if(code == -1) { g_retryAt = TimeLocal() + 5; return false; }
   Print("RadarFeed: write to ", path, " failed (HTTP ", code, "): ", resp);
   if(StringFind(resp, "expired") >= 0) g_token = "";
   else
   {
      Print("RadarFeed: if this says Permission denied, add this user's UID under feeders in the database and publish the feed rules.");
      g_retryAt = TimeLocal() + 30;
   }
   return false;
}

//--- pushes -------------------------------------------------------
void PushTicks()
{
   string j = "{\"ts\":{\".sv\":\"timestamp\"},\"connected\":" +
              (TerminalInfoInteger(TERMINAL_CONNECTED) != 0 ? "true" : "false") + ",\"pairs\":{";
   int added = 0;
   for(int i = 0; i < g_n; i++)
   {
      MqlTick t;
      if(!SymbolInfoTick(g_syms[i], t) || t.bid <= 0) continue;
      int dg     = (int)SymbolInfoInteger(g_syms[i], SYMBOL_DIGITS);
      int spread = (int)SymbolInfoInteger(g_syms[i], SYMBOL_SPREAD);
      if(added > 0) j += ",";
      j += "\"" + g_names[i] + "\":{\"bid\":" + DoubleToString(t.bid, dg) +
           ",\"ask\":" + DoubleToString(t.ask, dg) +
           ",\"spread\":" + IntegerToString(spread) +
           ",\"digits\":" + IntegerToString(dg) + "}";
      added++;
   }
   j += "}}";
   if(added > 0) Put("feed/ticks", j);
}

void PushBars()
{
   ENUM_TIMEFRAMES tfs[4] = {PERIOD_M5, PERIOD_M15, PERIOD_H1, PERIOD_H4};
   string          tfn[4] = {"M5", "M15", "H1", "H4"};
   string j = "{\"ts\":{\".sv\":\"timestamp\"},\"pairs\":{";
   int added = 0;
   for(int i = 0; i < g_n; i++)
   {
      int dg = (int)SymbolInfoInteger(g_syms[i], SYMBOL_DIGITS);
      string one = "";
      int ok = 0;
      for(int f = 0; f < 4; f++)
      {
         double c[];
         ArraySetAsSeries(c, false);               // oldest first
         int got = CopyClose(g_syms[i], tfs[f], 0, BarsCount, c);
         if(got < 30) continue;
         if(ok > 0) one += ",";
         one += "\"" + tfn[f] + "\":[";
         for(int b = 0; b < got; b++)
         {
            if(b > 0) one += ",";
            one += DoubleToString(c[b], dg);
         }
         one += "]";
         ok++;
      }
      if(ok == 0) continue;
      if(added > 0) j += ",";
      j += "\"" + g_names[i] + "\":{" + one + "}";
      added++;
   }
   j += "}}";
   if(added > 0) Put("feed/bars", j);
}

//--- events -------------------------------------------------------
int OnInit()
{
   if(FeedEmail == "" || FeedPassword == "")
   {
      Alert("RadarFeed: enter FeedEmail and FeedPassword in the Inputs tab.");
      return INIT_FAILED;
   }
   string parts[];
   int k = StringSplit(Pairs, ',', parts);
   ArrayResize(g_syms, 0);
   ArrayResize(g_names, 0);
   for(int i = 0; i < k; i++)
   {
      string p = parts[i];
      StringTrimLeft(p);
      StringTrimRight(p);
      if(p == "") continue;
      string sym = p + SymbolSuffix;
      if(!SymbolSelect(sym, true))
      {
         Print("RadarFeed: symbol not found at your broker: ", sym, " (check SymbolSuffix)");
         continue;
      }
      int n = ArraySize(g_syms);
      ArrayResize(g_syms, n + 1);
      ArrayResize(g_names, n + 1);
      g_syms[n]  = sym;
      g_names[n] = p;
   }
   g_n = ArraySize(g_syms);
   if(g_n == 0)
   {
      Alert("RadarFeed: none of the pairs were found. Check Pairs and SymbolSuffix.");
      return INIT_FAILED;
   }
   Print("RadarFeed: sending ", g_n, " pairs.");
   EventSetTimer(1);
   Login();
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   EventKillTimer();
}

void OnTick() {}

void OnTimer()
{
   datetime now = TimeLocal();
   if(now < g_retryAt) return;
   if(g_token == "" || now - g_loginAt > 2700)      // refresh the sign-in every 45 minutes
   {
      if(!Login()) return;
   }
   if(now - g_lastTick >= TickEverySec) { g_lastTick = now; PushTicks(); }
   if(g_token != "" && now - g_lastBars >= BarsEverySec) { g_lastBars = now; PushBars(); }
}
