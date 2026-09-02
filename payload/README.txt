
########################################################################
#                                                                      #
#        HOW TO START SCOUT   -   it's ONE double-click               #
#                                                                      #
########################################################################

        >>>   Double-click:   Start Button   <<<

That's the whole thing. Really. You do not need to read the rest of
this file to use Scout. Pick the file that matches your computer:
Start Button.bat on Windows, Start Button.command on a Mac, or
Start Button.sh on Linux.

WHAT HAPPENS THE FIRST TIME
  The first double-click sets everything up on its own.

  First, Start Button gets a small copy of Node onto the stick.
  That part is 35 to 50 MB and usually takes under a minute, even
  on a slow connection. A plain black window shows this happening,
  then closes down to almost nothing.

  Then Scout opens in your browser, and the browser takes over the
  rest: it downloads the AI itself, your voice, and your model,
  about five gigabytes in total, with a real progress bar on
  screen the whole time. This is the slow part, and it only
  happens once. After that, Scout starts in seconds.

  When it is all ready, Scout says hello.

HOW TO TALK TO SCOUT
  Hold down the space bar, or hold down the microphone button on
  screen, and talk. Let go when you are done, and Scout listens
  back and answers. You can also just type instead, any time.

CONNECTING GMAIL AND CALENDAR LATER
  Scout can read and send email, and check your calendar, but only
  once you connect them yourself from Settings. Nothing is
  connected out of the box.

  Gmail needs a Google App Password, a code you generate on
  Google's own site that works only for this. Calendar needs a
  secret calendar link from Google Calendar's settings. Both are
  explained step by step on screen when you get there. A PIN you
  choose protects both once they are connected, so someone else
  picking up the stick cannot use them without it.

IF THE WINDOW DOES NOT OPEN BY ITSELF
  Start Button leaves a shortcut called Open Assistant right next
  to it in this folder. Double-click that.

  The port is not always the same number, so the shortcut is
  rewritten once Scout is actually listening rather than pointing
  at a guess. If you ever need it, the address is
  http://127.0.0.1 followed by the port Scout picked.

WINDOWS NOTES
  Windows may show a blue box that says "Windows protected your
  PC". This is Microsoft SmartScreen being cautious about a new
  program, not a real warning about Scout. Click "More info", then
  "Run anyway".

  If security software ever removes a downloaded file (some
  antivirus tools are quick to flag AI engines they do not
  recognize), just run Start Button again. It notices the file is
  missing and fetches it again automatically. This is a known
  false alarm, not a sign anything is wrong.

MAC NOTES
  The first time you open Start Button.command, macOS may ask you
  to confirm before it runs, since it was copied off the web.

  On macOS 15 (Sequoia) and later: open System Settings, then
  Privacy and Security, then choose Open Anyway.
  On older macOS versions: right-click the file and choose Open.

  If you do not have Chrome or Edge installed, Scout opens in
  Safari instead, and a couple of small things on screen look
  slightly different there. Everything still works.

  LINUX: if double-clicking Start Button.sh does nothing, right-
  click it and look for an option to allow it to run as a program,
  or open a terminal in this folder and run once:
  chmod +x "Start Button.sh"

WHAT STAYS ON THE STICK, AND WHAT LEAVES THE MACHINE
  Everything, including your model, your chats, and your settings,
  lives on this USB stick. The app server only ever listens on
  127.0.0.1, meaning nothing on the network can reach it, and it
  reaches nothing on its own.

  The only things that ever leave this machine are Gmail and
  Google Calendar, and only after you connect them yourself. Every
  time Scout does either, it is logged in the "What Scout just
  did" window on screen, and marked "leaves this machine" so you
  always know.

WHAT SCOUT DOES NOT DO
  Scout does not work well on a company-managed laptop; many block
  software from USB sticks on purpose, and there is no way around
  that. On a workplace network that blocks outside mail servers,
  Gmail may not connect even with a correct App Password. Scout
  never emails an address it only heard spoken aloud without you
  confirming it first, in writing, on screen. And Scout never
  deletes anything: there is no delete built in at all.

TO STOP
  Just close the black window. Everything stops with it, and
  everything you did stays right here on the stick.
