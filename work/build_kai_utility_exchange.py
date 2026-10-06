from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.colors import HexColor
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph, Table, TableStyle
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_RIGHT
from reportlab.lib.units import mm
from reportlab.pdfbase.pdfmetrics import stringWidth
from xml.sax.saxutils import escape
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / 'outputs' / 'KAI_AI_Utility_Exchange_企划.pdf'
FONT = '/System/Library/Fonts/Supplemental/Arial Unicode.ttf'
pdfmetrics.registerFont(TTFont('KaiSans', FONT))

W, H = A4
M = 18*mm
NAVY = HexColor('#0B1B2A')
DEEP = HexColor('#102D42')
TEAL = HexColor('#0E7C7B')
MINT = HexColor('#CDEFE8')
CYAN = HexColor('#6ED6D0')
ORANGE = HexColor('#FFB45C')
RED = HexColor('#E76F51')
INK = HexColor('#173143')
MID = HexColor('#567181')
LIGHT = HexColor('#F2F7F8')
PALE = HexColor('#EAF4F3')
WHITE = colors.white
GRID = HexColor('#C9D9DE')

styles = {}
def style(name, size, leading=None, color=INK, bold=False, align=TA_LEFT):
    styles[name] = ParagraphStyle(name=name, fontName='KaiSans', fontSize=size, leading=leading or size*1.35, textColor=color, alignment=align, spaceAfter=0, spaceBefore=0)
style('body', 9.2, 13.2, INK)
style('small', 7.2, 10.5, MID)
style('tiny', 6.2, 8.5, MID)
style('h1', 25, 30, NAVY, True)
style('white_h1', 25, 30, WHITE, True)
style('h2', 17, 22, NAVY, True)
style('formula', 13.8, 18, NAVY, True)
style('h3', 11.3, 15, TEAL, True)
style('metric', 25, 27, NAVY, True)
style('metric_small', 17, 20, NAVY, True)
style('white_body', 9.2, 13.2, WHITE)
style('white_small', 7.5, 10.5, HexColor('#D5EFEC'))
style('center_body', 9.0, 12.4, INK, False, TA_CENTER)
style('center_small', 7.4, 10, MID, False, TA_CENTER)


def P(text, sty='body'):
    return Paragraph(text, styles[sty])

def draw_p(c, text, x, y_top, width, sty='body'):
    p = P(text, sty)
    w,h = p.wrap(width, H)
    p.drawOn(c, x, y_top-h)
    return y_top-h

def draw_center_p(c, text, x, y_top, width, sty='center_body'):
    p = P(text, sty)
    w,h = p.wrap(width, H)
    p.drawOn(c, x+(width-w)/2, y_top-h)
    return y_top-h

def rect(c, x,y,w,h, fill, stroke=None, radius=8, sw=1):
    c.setFillColor(fill)
    if stroke:
        c.setStrokeColor(stroke); c.setLineWidth(sw)
    else:
        c.setStrokeColor(fill)
    c.roundRect(x,y,w,h,radius,fill=1,stroke=1 if stroke else 0)

def line(c,x1,y1,x2,y2,color=GRID,sw=0.7,dash=None):
    c.setStrokeColor(color); c.setLineWidth(sw)
    if dash: c.setDash(dash)
    c.line(x1,y1,x2,y2)
    c.setDash()

def pill(c, text, x,y,w, fill=PALE, color=TEAL, fs=7.2):
    rect(c,x,y,w,16,fill,radius=8)
    c.setFillColor(color); c.setFont('KaiSans',fs); c.drawCentredString(x+w/2,y+5,text)

def footer(c, n, label='KAI AI Utility Exchange · 企划稿'):
    line(c,M,15*mm,W-M,15*mm,GRID,0.5)
    c.setFillColor(MID); c.setFont('KaiSans',6.5); c.drawString(M,10*mm,label)
    c.setFillColor(MID); c.setFont('KaiSans',7); c.drawRightString(W-M,10*mm,f'{n:02d}')

def title(c, kicker, head, sub=None, page_no=None):
    c.setFillColor(TEAL); c.setFont('KaiSans',7.4); c.drawString(M, H-24*mm, kicker.upper())
    draw_p(c, head, M, H-31*mm, W-2*M, 'h1')
    if sub: draw_p(c, sub, M, H-65*mm, W-2*M, 'body')
    if page_no: footer(c,page_no)

def metric_card(c,x,y,w,h,num,label,detail='',accent=TEAL):
    rect(c,x,y,w,h,WHITE,GRID,8,0.6)
    c.setFillColor(accent); c.rect(x,y+h-4,w,4,fill=1,stroke=0)
    c.setFillColor(NAVY); c.setFont('KaiSans',22 if len(num)<9 else 17); c.drawString(x+10,y+h-31,num)
    draw_p(c,label,x+10,y+h-39,w-20,'h3')
    if detail: draw_p(c,detail,x+10,y+(32 if h > 100 else 14),w-20,'small')

def bullet(c, text, x,y_top,width, color=INK, fs='body', dot=TEAL):
    c.setFillColor(dot); c.circle(x+3,y_top-6,2.3,fill=1,stroke=0)
    return draw_p(c,text,x+12,y_top,width-12,fs)

def tag(c, text, x,y, fill=PALE, color=TEAL):
    w=stringWidth(text,'KaiSans',7.2)+16
    pill(c,text,x,y,w,fill,color,7.2)
    return w

def draw_table(c, data, x, y_top, col_widths, row_h=None, header=True, font=7.4, header_fill=DEEP):
    rows=[]
    for r,row in enumerate(data):
        rr=[]
        for cell in row:
            txt = str(cell)
            sty = ParagraphStyle(f't{r}', fontName='KaiSans', fontSize=font, leading=font*1.35, textColor=WHITE if (header and r==0) else INK)
            rr.append(Paragraph(txt, sty))
        rows.append(rr)
    tbl=Table(rows,colWidths=col_widths,rowHeights=row_h,hAlign='LEFT')
    ts=[('VALIGN',(0,0),(-1,-1),'TOP'),('LEFTPADDING',(0,0),(-1,-1),7),('RIGHTPADDING',(0,0),(-1,-1),7),('TOPPADDING',(0,0),(-1,-1),6),('BOTTOMPADDING',(0,0),(-1,-1),6),('GRID',(0,0),(-1,-1),0.35,GRID)]
    if header:
        ts += [('BACKGROUND',(0,0),(-1,0),header_fill),('TEXTCOLOR',(0,0),(-1,0),WHITE)]
        for i in range(1,len(data)):
            ts.append(('BACKGROUND',(0,i),(-1,i), WHITE if i%2 else LIGHT))
    tbl.setStyle(TableStyle(ts))
    w,h=tbl.wrapOn(c,sum(col_widths),H)
    tbl.drawOn(c,x,y_top-h)
    return y_top-h

def new_page(c):
    c.showPage()

c=canvas.Canvas(str(OUT), pagesize=A4)
c.setTitle('KAI AI Utility Exchange 企划')
c.setAuthor('KAI')

# PAGE 1 cover
c.setFillColor(NAVY); c.rect(0,0,W,H,fill=1,stroke=0)
# abstract grid
for i in range(9):
    line(c, M+i*25*mm, 44*mm, M+i*25*mm, H-22*mm, HexColor('#173B50'),0.4)
for j in range(9):
    line(c,M,48*mm+j*26*mm,W-M,48*mm+j*26*mm,HexColor('#173B50'),0.4)
c.setFillColor(CYAN); c.setFont('KaiSans',8); c.drawString(M, H-27*mm, 'KAI  ·  GROWTH / MARKET / AGENT')
draw_p(c,'<font color="#FFFFFF">KAI AI</font><br/><font color="#6ED6D0">Utility Exchange</font>',M,H-44*mm,W-2*M,'white_h1')
draw_p(c,'把小时 Key 从“可购买的服务”升级为<br/>“可持有、可交易、可使用、可被 AI 发现的时段权益”。',M,H-92*mm,W-2*M,'white_body')
# large callout
rect(c,M,75*mm,W-2*M,47*mm,DEEP,HexColor('#285A6A'),12,0.8)
draw_center_p(c,'24 个整点窗口  ×  持仓权益  ×  KaiKey 事实中心',M+10,110*mm,W-2*M-20,'white_body')
draw_center_p(c,'让用户不是“买一次 API”，而是进入一个持续产生选择、使用和交易的小时市场。',M+12,96*mm,W-2*M-24,'white_small')
c.setFillColor(HexColor('#C8DCE0')); c.setFont('KaiSans',7.5); c.drawString(M,26*mm,'企划版本 · 2026.10.02 · Leader Review Draft')
c.setFillColor(CYAN); c.setFont('KaiSans',7.5); c.drawRightString(W-M,26*mm,'KAI AI Utility Exchange')
new_page(c)

# PAGE 2 thesis
c.setFillColor(LIGHT); c.rect(0,0,W,H,fill=1,stroke=0)
title(c,'01 / 核心判断','KAI 不缺一个工具商城，缺的是一层“小时权益的使用层”','工具承接需求，小时权益才是核心标的：让它在使用时持续产生结果，在交易时产生流动性，在 AI 入口持续可被发现。',2)
# three cards
card_y=H-120*mm; gap=6*mm; cw=(W-2*M-2*gap)/3
metric_card(c,M,card_y,cw,46*mm,'1 小时','权益单位','固定模型 × 规格 × 区域 × 预约起止',TEAL)
metric_card(c,M+cw+gap,card_y,cw,46*mm,'24 次','每日节奏','每个自然日都有 24 个可被定价、预订和交付的时段窗口',ORANGE)
metric_card(c,M+2*(cw+gap),card_y,cw,46*mm,'85 家','网络上限','当前材料中的 Broker 规划规模；不是已上线数量',CYAN)
# thesis bar
rect(c,M,card_y-35*mm,W-2*M,25*mm,DEEP,radius=10)
draw_p(c,'企划命题',M+12,card_y-18*mm,34*mm,'white_small')
draw_p(c,'让 KAI 成为“小时 AI 服务”的入口、持仓管理器、交易事实源和 Agent 可调用的市场。',M+85,card_y-12*mm,W-2*M-100,'white_body')
# flow
base=card_y-65*mm
labels=[('供给','Broker'),('封装','Pack'),('持仓/支付','Store'),('交易事实','KaiKey'),('行情学习','Quant')]
for i,(a,b) in enumerate(labels):
    x=M+i*((W-2*M-20)/5)
    rect(c,x,base,50*mm,22*mm,WHITE,GRID,8,0.6)
    draw_center_p(c,a,x,base+16*mm,50*mm,'h3')
    draw_center_p(c,b,x,base+8*mm,50*mm,'small')
    if i<4:
        c.setFillColor(TEAL); c.setFont('KaiSans',14); c.drawString(x+52*mm,base+8*mm,'→')
draw_p(c,'核心变化：Utility Exchange 不是新建第六个平台，而是把现有五个角色连接成一条“买到权益 → 使用权益 → 证明结果 → 继续交易”的增长链。',M,base-16*mm,W-2*M,'body')
footer(c,2)
new_page(c)

# PAGE 3 existing model
c.setFillColor(WHITE); c.rect(0,0,W,H,fill=1,stroke=0)
title(c,'02 / 贴合 KAI 现状','KAI 已经拥有 Utility Exchange 的骨架','上传材料中，KAI 的真实对象不是泛 API，而是可验证的小时服务权益；企划只需要补上“使用层”和“GEO 分发层”。',3)
# left architecture
x=M; y=H-82*mm; w=83*mm
rect(c,x,y-92*mm,w,92*mm,PALE,radius=10)
draw_p(c,'现有对象',x+10,y-8*mm,w-20,'h2')
items=[('Key Broker','供给接入、客户经营、履约协调'),('Key Pack','商品封装、模板、Agent'),('Key Store','支付、余额、账单、持仓入口'),('KaiKey','订单、成交、清算、权益事实'),('Quant','行情、研究、经营分析')]
for i,(a,b) in enumerate(items):
    yy=y-23*mm-i*13*mm
    c.setFillColor(TEAL); c.circle(x+13,yy+2,3,fill=1,stroke=0)
    draw_p(c,f'<b>{a}</b><br/>{b}',x+22,yy+8,w-32,'small')
# right gap
rx=M+93*mm; rw=W-M-rx; yy=H-88*mm
draw_p(c,'这套体系的隐形优势',rx,yy,rw,'h2')
yy-=18*mm
pts=[
    '<b>供给不是一次性内容：</b>每个小时 Key 都绑定模型、规格、区域和预约起止，天然形成可比较的“时段商品”。',
    '<b>持仓不是消费记录：</b>未开始的权益可使用、交割、转售、转赠或续期，KAI 因此拥有持续触达用户的理由。',
    '<b>成交不是页面事件：</b>KaiKey 保存订单、成交、结算、所有权、交付回执，Quant 只从真实事件生成行情。',
    '<b>Agent 不是聊天装饰：</b>它读取需求、库存、时间窗和预算，返回可执行的方案，而不是泛泛推荐模型。'
]
for p in pts:
    yy=bullet(c,p,rx,yy,rw,'body'); yy-=8
# bottom quote
rect(c,rx,46*mm,rw,27*mm,DEEP,radius=10)
draw_p(c,'一句话定位',rx+12,67*mm,rw-24,'white_small')
draw_p(c,'KAI 把模型 API 的不确定选择，改造成可买、可持有、可使用、可转让的小时服务权益。',rx+12,61*mm,rw-24,'white_body')
footer(c,3)
new_page(c)

# PAGE 4 hourly timing
c.setFillColor(LIGHT); c.rect(0,0,W,H,fill=1,stroke=0)
title(c,'03 / 隐形增值一','整点起止，不只是时间格式，而是 KAI 的“库存时钟”','小时 Key 的真正价值，在于它把 AI 能力变成有起点、有锁定、有交付、有失效边界的时段权益。',4)
# timeline
x0=M; x1=W-M; ty=H-100*mm
line(c,x0,ty,x1,ty,DEEP,2)
points=[(0,'H−1h','交易窗口','可购买、转售、转让、重新选择'),(0.42,'G','锁定窗口','停止新增交易；固定最终交付安排'),(0.67,'H','服务开始','调用权限开启；开始计量和履约'),(1.0,'H+1h','服务结束','未使用不顺延；容量回到历史事实')]
for pos,top,lab,desc in points:
    xx=x0+pos*(x1-x0)
    c.setFillColor(ORANGE if top=='G' else TEAL); c.circle(xx,ty,5,fill=1,stroke=0)
    draw_center_p(c,top,xx-22,ty+15,44,'h3')
    draw_center_p(c,lab,xx-35,ty-17,70,'small')
    desc_w=90
    desc_x=max(M,min(W-M-desc_w,xx-desc_w/2))
    draw_center_p(c,desc,desc_x,ty-34,desc_w,'tiny')
# four value cards
cy=ty-75*mm; gap=5*mm; cw=(W-2*M-3*gap)/4
cards=[('01','可预订','需求在服务开始前被锁定，供应商能看到未来容量。'),('02','可交易','未锁定权益可以进入转售、转让和组合流转。'),('03','可证明','交付、调用、错误率和首 Token 延迟都有明确时间窗。'),('04','会失效','未使用不顺延，时间本身成为稀缺性与复购触发器。')]
for i,(n,lab,desc) in enumerate(cards):
    xx=M+i*(cw+gap)
    rect(c,xx,cy,cw,36*mm,WHITE,GRID,8,0.6)
    c.setFillColor(TEAL); c.setFont('KaiSans',14); c.drawString(xx+9,cy+25*mm,n)
    draw_p(c,lab,xx+9,cy+20*mm,cw-18,'h3')
    draw_p(c,desc,xx+9,cy+12*mm,cw-18,'small')
# bottom big number
rect(c,M,34*mm,W-2*M,22*mm,DEEP,radius=9)
draw_center_p(c,'24 个整点窗口 / 天  ·  8,760 个小时窗口 / 年  ·  85 Broker 理论上限 = 744,600 Broker·小时窗口 / 年',M+10,49*mm,W-2*M-20,'white_body')
draw_center_p(c,'后一个数字是容量上限推导：85 × 24 × 365；不代表当前已售或已上线。',M+10,40*mm,W-2*M-20,'white_small')
footer(c,4)
new_page(c)

# PAGE 5 holdings
c.setFillColor(WHITE); c.rect(0,0,W,H,fill=1,stroke=0)
title(c,'04 / 隐形增值二','持仓，把一次购买变成持续关系','用户不是只得到一次调用，而是获得一份带来源、时段、数量和状态的服务权益；Utility Exchange 要围绕这份权益工作。',5)
# holding stack diagram
left=M; top=H-83*mm
rect(c,left,top-92*mm,75*mm,92*mm,DEEP,radius=10)
draw_center_p(c,'我的 KAI 持仓',left,top-10*mm,75*mm,'white_body')
for i,(lab,val,col) in enumerate([('东亚 · GPT-X · 18:00','12 Key',CYAN),('北欧 · Claude-Y · 19:00','8 Key',ORANGE),('南美 · GPU-A · 20:00','20 Key',MINT)]):
    yy=top-28*mm-i*19*mm
    rect(c,left+10,yy,55*mm,13*mm,HexColor('#193B4F'),radius=5)
    c.setFillColor(col); c.setFont('KaiSans',8); c.drawString(left+15,yy+8*mm,lab)
    c.setFillColor(WHITE); c.setFont('KaiSans',10); c.drawRightString(left+62*mm,yy+4*mm,val)
# arrows and benefits
rx=left+86*mm; rw=W-M-rx; yy=top-7*mm
draw_p(c,'持仓带来的四个增量',rx,yy,rw,'h2')
benefits=[
    ('可用','工具只读取用户真实持有的模型与时段，不向用户承诺不存在的自动切换。'),
    ('可比','同一模型、同一规格、同一区域、同一时段才进入可比报价和行情。'),
    ('可流转','服务开始前，未锁定权益可申请交割、转售、转赠或续期。'),
    ('可复购','每次服务结束都产生下一次预约、续期、升级或补充容量的入口。')
]
for i,(lab,desc) in enumerate(benefits):
    yb=yy-15*mm-i*17*mm
    c.setFillColor(TEAL); c.setFont('KaiSans',10); c.drawString(rx,yb,lab)
    draw_p(c,desc,rx+28,yb+3,rw-28,'small')
# right bottom formula
rect(c,M,30*mm,W-2*M,36*mm,PALE,radius=10)
draw_p(c,'持仓价值公式',M+12,57*mm,W-2*M-24,'h3')
draw_p(c,'持仓价值 = 可用小时 × 适配度 × 稀缺度 × 可流转性 × 交付可信度',M+12,50*mm,W-2*M-24,'formula')
draw_p(c,'这不是现金估值；它是决定工具推荐、二次购买和交易优先级的权益评分。',M+12,37*mm,W-2*M-24,'small')
footer(c,5)
new_page(c)

# PAGE 6 exchange
c.setFillColor(LIGHT); c.rect(0,0,W,H,fill=1,stroke=0)
title(c,'05 / 隐形增值三','KaiKey 交易所，让小时 Key 产生价格和流动性','没有统一的标的、订单、成交和权益事实，小时 Key 只能是商品列表；有了 KaiKey，才会出现可验证的时段市场。',6)
# order book graphic
x=M; y=H-90*mm; w=W-2*M
rect(c,x,y-75*mm,w,75*mm,WHITE,GRID,10,0.6)
draw_p(c,'KaiKey · Hourly Rights Order Book',x+12,y-10*mm,w-24,'h3')
# header
headers=['标的','区域 / 时段','卖方数量','可用量','可执行价','状态']
cols=[42*mm,40*mm,22*mm,22*mm,25*mm,22*mm]
data=[headers,
 ['GPT-X / 1h','东亚 · 18:00','3','420','0.92 USD','可售'],
 ['Claude-Y / 1h','北欧 · 19:00','2','180','0.78 USD','可售'],
 ['GPU-A / 1h','南美 · 20:00','1','60','1.10 USD','临界']]
draw_table(c,data,x+12,y-19*mm,cols,font=7.2)
# pillars
py=y-96*mm; gap=5*mm; pw=(w-2*gap)/3
pillars=[('统一标的','模型 × 规格 × 区域 × 预约小时','用户知道自己买了什么。'),('真实成交','Order → Trade → Settlement','报价、成交和模拟数据分开。'),('权益事实','Holding → Delivery → Usage','持仓、交付和使用可以回查。')]
for i,(a,b,d) in enumerate(pillars):
    xx=x+i*(pw+gap)
    rect(c,xx,py,pw,34*mm,DEEP,radius=8)
    draw_center_p(c,a,xx,py+26*mm,pw,'white_body')
    draw_center_p(c,b,xx+5,py+17*mm,pw-10,'white_small')
    draw_center_p(c,d,xx+5,py+8*mm,pw-10,'white_small')
# quant line
rect(c,M,31*mm,W-2*M,17*mm,ORANGE,radius=8)
draw_center_p(c,'Quant 只从真实委托、成交、交付和更正事件生成行情；这使 GEO 内容有“事实来源”，而不是广告文案。',M+10,43*mm,W-2*M-20,'center_body')
footer(c,6)
new_page(c)

# PAGE 7 utility layer
c.setFillColor(WHITE); c.rect(0,0,W,H,fill=1,stroke=0)
title(c,'06 / 产品形态','KAI AI Utility Exchange：小时权益的使用增值层', '工具不替代 Key；工具把“已持有的小时权益”变成可直接完成工作的结果。',7)
# product flow boxes
flow_y=H-100*mm
flow=[('用户需求','我要在 18:00 做一份研究简报'),('Agent 选购','识别模型、区域、时段、预算和并发'),('权益绑定','读取用户已持有或可购买的 Key'),('工具执行','在权益边界内完成任务'),('结果证明','输出成本、模型、时间和回执')]
fw=(W-2*M-4*4*mm)/5
for i,(a,b) in enumerate(flow):
    xx=M+i*(fw+4*mm)
    rect(c,xx,flow_y,fw,30*mm,PALE,GRID,8,0.6)
    c.setFillColor(TEAL); c.setFont('KaiSans',7); c.drawCentredString(xx+fw/2,flow_y+23*mm,f'{i+1:02d}')
    draw_center_p(c,a,xx+3,flow_y+18*mm,fw-6,'h3')
    draw_center_p(c,b,xx+5,flow_y+8*mm,fw-10,'tiny')
    if i<4:
        c.setFillColor(TEAL); c.setFont('KaiSans',14); c.drawString(xx+fw+0.5*mm,flow_y+11*mm,'→')
# tools table
start=flow_y-18*mm
draw_p(c,'首批工具不是泛化工具包，而是直接服务小时 Key 的四个动作',M,start,W-2*M,'h2')
table=[['工具','绑定的 KAI 对象','用户得到的结果'],
['Key Fit','Instrument / Offer','知道哪种 Key 能完成任务，看到价格和取舍'],
['Slot Planner','Lot / serviceWindow','看到整点起止、连续时段和锁定时间'],
['KAI Workbench','Holding / Delivery','在自己持有的权益内执行研究、文档或批量任务'],
['Usage Proof','Trade / Receipt / Usage','拿到模型、成本、时间、状态和可分享证明']]
draw_table(c,table,M,start-9*mm,[31*mm,48*mm,W-2*M-79*mm],font=7.4)
# note
rect(c,M,31*mm,W-2*M,18*mm,DEEP,radius=8)
draw_center_p(c,'工具额度以“有限任务包”或“首月含量”发放；不做无边界免费调用。',M+10,43*mm,W-2*M-20,'white_body')
footer(c,7)
new_page(c)

# PAGE 8 GEO
c.setFillColor(LIGHT); c.rect(0,0,W,H,fill=1,stroke=0)
title(c,'07 / GEO 落地','GEO 的入口不是 slogan，而是“可被回答的小时市场事实”','KAI 每一个可售时段，都可以成为一个结构化、可验证、可被 Agent 查询的答案节点。',8)
# flywheel circle-ish boxes
cx=W/2; cy=H-112*mm
nodes=[('问题','哪家模型<br/>18:00 有 Key？'),('事实','价格 / 区域 /<br/>库存 / 时效'),('方案','Agent 三选<br/>与取舍'),('交易','Order / Trade<br/>Holding'),('证据','Receipt / Usage<br/>可分享结果')]
coords=[(cx-15*mm,cy+29*mm),(cx+38*mm,cy+5*mm),(cx+14*mm,cy-39*mm),(cx-38*mm,cy-39*mm),(cx-58*mm,cy+5*mm)]
for i,((a,b),(xx,yy)) in enumerate(zip(nodes,coords)):
    rect(c,xx,yy,34*mm,22*mm,WHITE,TEAL,10,0.8)
    draw_center_p(c,a,xx,yy+15*mm,34*mm,'h3')
    draw_center_p(c,b,xx+3,yy+7*mm,28*mm,'tiny')
    nx,ny=coords[(i+1)%5]
    line(c,xx+17*mm,yy+11*mm,nx+17*mm,ny+11*mm,CYAN,1.2,dash=[3,2])
# GEO assets
base=cy-78*mm
draw_p(c,'四类 GEO 资产',M,base,W-2*M,'h2')
assets=[('结构化标的页','模型、规格、区域、预约小时、可用量、有效报价'),('时段问题页','“现在能买什么”“哪个时段连续”“如何比较成本”'),('履约案例页','真实交付、延迟、错误率、补救与用户结果'),('工具分享页','用户可复制的模板、结果和 KAI 来源标识')]
for i,(a,b) in enumerate(assets):
    xx=M+(i%2)*(W/2- M/2); yy=base-13*mm-(i//2)*24*mm
    rect(c,xx,yy,W/2-M/2,18*mm,PALE,radius=7)
    draw_p(c,a,xx+9,yy+13*mm,W/2-M/2-18,'h3')
    draw_p(c,b,xx+9,yy+6*mm,W/2-M/2-18,'small')
# bottom
rect(c,M,31*mm,W-2*M,18*mm,DEEP,radius=8)
draw_center_p(c,'GEO 闭环：问题 → 市场事实 → Agent 方案 → 交易 → 使用证据 → 可分享内容 → 下一次问题',M+10,43*mm,W-2*M-20,'white_body')
footer(c,8)
new_page(c)

# PAGE 9 quant
c.setFillColor(WHITE); c.rect(0,0,W,H,fill=1,stroke=0)
title(c,'08 / 量化模型','把冲击力放在“窗口、持仓、交易和复用”上','本页严格区分：材料事实、由事实推导的上限、未来情景测算。情景数字用于决策，不代表当前已实现。',9)
# data tiers
rect(c,M,H-104*mm,W-2*M,23*mm,PALE,radius=8)
legend=[('事实','材料已明确或已存在的规则',TEAL),('推导','从事实公式计算的容量上限',ORANGE),('情景','未来目标参数的假设测算',RED)]
xx=M+10
for lab,desc,col in legend:
    c.setFillColor(col); c.circle(xx+3,H-92*mm,3,fill=1,stroke=0)
    c.setFillColor(INK); c.setFont('KaiSans',7.2); c.drawString(xx+10,H-94*mm,lab)
    c.setFillColor(MID); c.setFont('KaiSans',6.5); c.drawString(xx+10,H-99*mm,desc)
    xx+=57*mm
# capacity table
top=H-116*mm
data=[['层级','数字','口径'],
['事实','1 小时','Key 对应固定模型/规格/区域/预约时段；开始前锁定，开始后服务'],
['事实','24 个','每个自然日的整点窗口数量'],
['事实','85 家','Broker 规划规模，非已上线数量'],
['推导','8,760','单个标的的小时窗口/年：24 × 365'],
['推导','744,600','85 Broker 的理论 Broker·小时窗口/年：85 × 24 × 365'],
['情景','7.446M / 74.46M / 744.6M','若每个 Broker·小时分别承载 10 / 100 / 1,000 个 Key 的年化 Key·小时']]
draw_table(c,data,M,top,[22*mm,34*mm,W-2*M-56*mm],font=7.2)
# fee model
fy=top-75*mm
draw_p(c,'费用池示意（当前材料的暂定参数）',M,fy,W-2*M,'h2')
fee=[['假设商品额 1,000 USD','金额','说明'],['供应商基础应收','720','按 28% 初售佣金池的简化示例'],['Pack 分成','60','6%，已包含在 28% 内'],['Broker 留存','220','28% − 6%，未扣返利与运营成本'],['Store 服务费','1','0.10%，买方另付；不是价差']]
draw_table(c,fee,M,fy-9*mm,[54*mm,28*mm,W-2*M-82*mm],font=7.2)
rect(c,M,31*mm,W-2*M,18*mm,DEEP,radius=8)
draw_center_p(c,'工具成本 U 作为获客/复购预算，不能改变供应商净回款和既有分账规则。',M+10,43*mm,W-2*M-20,'white_body')
footer(c,9)
new_page(c)

# PAGE 10 metrics
c.setFillColor(LIGHT); c.rect(0,0,W,H,fill=1,stroke=0)
title(c,'09 / 经营指标','真正要看的，不是曝光量，而是“权益到结果”的转化','KAI AI Utility Exchange 的经营指标必须同时覆盖市场流动性、权益使用、工具复用和 GEO 发现。',10)
# matrix
matrix=[['层级','核心指标','计算方式 / 解释'],
['市场','可执行报价率','可售 Offer 中可在目标时段完成锁定的比例'],
['持仓','Holding Activation','已持有权益在服务窗内产生一次有效调用的比例'],
['工具','Utility Attach Rate','购买/持有小时 Key 后使用至少一个工具的比例'],
['履约','Receipt Success Rate','交付回执为成功且可回查的服务比例'],
['复购','7D / 30D Repeat','用户在首次服务后再次购买、续期或转售的比例'],
['GEO','AI Mention → Offer CTR','AI/搜索提及后进入可执行报价页的比例'],
['经营','Net Fee after U','手续费与分成收入 − 工具调用成本 − 支持/退款成本']]
draw_table(c,matrix,M,H-84*mm,[27*mm,43*mm,W-2*M-70*mm],font=7.2)
# score cards
sy=58*mm; gap=5*mm; cw=(W-2*M-2*gap)/3
metric_card(c,M,sy,cw,28*mm,'1','先看有效结果','首个有效结果时间；不是注册量',TEAL)
metric_card(c,M+cw+gap,sy,cw,28*mm,'2','再看权益复用','7D / 30D 再购买、使用、转售',ORANGE)
metric_card(c,M+2*(cw+gap),sy,cw,28*mm,'3','最后看规模','Broker、时段、工具和 GEO 扩张',CYAN)
rect(c,M,31*mm,W-2*M,17*mm,DEEP,radius=8)
draw_center_p(c,'任何规模目标，必须先通过：真实报价 → 真实锁定 → 真实交付 → 真实使用 → 真实复购。',M+10,43*mm,W-2*M-20,'white_body')
footer(c,10)
new_page(c)

# PAGE 11上线能力与验收
c.setFillColor(WHITE); c.rect(0,0,W,H,fill=1,stroke=0)
title(c,'10 / 上线能力与验收','把企划变成一组可独立验收的正式能力','每项能力按正式上线标准定义接口、事实来源和验收证据；接入可以后置，但能力本身不写死为不可执行。',11)
road=[('C1','契约稳定','Offer / Grant / Holding / Receipt 统一字段、schema 和版本','验证接口可演进且旧客户端不被写死'),('C2','真实行情与小时 Key','市场 Offer 映射与 Hour Key 包装，保留 executionEligible 与 hourKeyStatus','验证真实行情、封装状态和报价一致'),('C3','账户与持仓事实','账户 Key、Holding、时间窗与 scope 由授权记录连接','验证账户 Key 不变、范围扩展有授权版本'),('C4','供应商履约与回执','Provider、Usage、Delivery Proof、Receipt 接入后可回查','验证真实执行、失败和退款证据'),('C5','增长与运营','Agent、GEO、转售、Quant 和多 Broker 建立在同一事实链','验证流量、成交、使用、复购和回流')]
ry=H-87*mm
for i,(phase,a,b,cx) in enumerate(road):
    yy=ry-i*29*mm
    c.setFillColor(TEAL if i<2 else ORANGE); c.setFont('KaiSans',11); c.drawString(M,yy,phase)
    line(c,M+18*mm,yy+2,M+28*mm,yy+2,GRID,1.2)
    rect(c,M+31*mm,yy-11*mm,W-M-31*mm,22*mm,PALE if i<2 else LIGHT,GRID,8,0.6)
    draw_p(c,a,M+41*mm,yy+6*mm,36*mm,'h3')
    draw_p(c,b,M+80*mm,yy+6*mm,82*mm,'small')
    draw_p(c,cx,M+166*mm,yy+6*mm,W-M-176*mm,'small')
# decision box
rect(c,M,34*mm,W-2*M,32*mm,DEEP,radius=10)
draw_p(c,'Leader 需要批准的三件事',M+12,61*mm,W-2*M-24,'white_small')
for i,t in enumerate(['把 Utility Exchange 作为 KAI 现有体系的对客增长能力，而非新增孤立产品。','先以一个模型、一个区域、一个高频工作流验证“持仓 → 工具 → 复购”。','用真实成交和交付证据生成 GEO 资产，所有未来数字以情景测算标识。']):
    bullet(c,t,M+14,54*mm-i*8*mm,W-2*M-28,WHITE,'white_small',CYAN)
footer(c,11)
new_page(c)

# PAGE 12 appendix sources
c.setFillColor(LIGHT); c.rect(0,0,W,H,fill=1,stroke=0)
title(c,'附录 / 数据口径','数据从哪里来，哪些是事实，哪些是推导','本企划不把目标情景写成已经实现的结果；每个强冲击数字都保留口径。',12)
source_data=[['类别','本企划使用的内容','标记方式'],
['材料事实','小时 Key、H/G 时间窗、Broker/Pack/Store/KaiKey/Quant 关系、85 Broker 规划','事实'],
['方案规则','Pack 6%、初售佣金 28%、Store 0.10%等当前材料参数','方案参数 / 待最终协议'],
['公式推导','24×365、85×24×365、Key·小时容量上限','推导上限'],
['未来情景','每个小时承载 10/100/1,000 Key、工具预算 U、GEO 转化目标','目标情景 / 待验证'],
['验收事实','报价、锁定、成交、交付回执、使用和复购事件','以系统真实事件为准']]
draw_table(c,source_data,M,H-83*mm,[31*mm,100*mm,W-2*M-131*mm],font=7.2)
# references
ry=H-166*mm
draw_p(c,'内部参考材料',M,ry,W-2*M,'h2')
refs=[
'• 北斗比芯智算集团有限公司｜KAI（4页定位说明）',
'• KAI KEY 体系白皮书（Broker / Pack / Store / Quant）',
'• Key Broker 业务白皮书｜区域经营、订单、履约与复购',
'• Key Pack 业务白皮书｜商品封装、Agent、模板与工具',
'• KaiKey 四平台体系与 Agent 交易闭环方案 v2.0',
'• KaiKey 区域 Pack 架构与分账方案｜当前暂定费用参数'
]
for i,r in enumerate(refs):
    draw_p(c,r,M,ry-12*mm-i*8*mm,W-2*M,'small')
rect(c,M,31*mm,W-2*M,18*mm,DEEP,radius=8)
draw_center_p(c,'最终原则：把远期数据写成目标，把当前能力写成事实，把冲击力放在可计算的小时窗口和真实权益流转上。',M+10,43*mm,W-2*M-20,'white_body')
footer(c,12)

# PAGE 13 investment logic / external comparisons
new_page(c)
c.setFillColor(WHITE); c.rect(0,0,W,H,fill=1,stroke=0)
title(c,'附录 / 投资判断','造价高的地方，不在工具本身，而在“事实链 + 时段流动性”','完整交易所的成本来自供给接入、库存锁定、订单清算、交付回执和可回查数据；Utility 工具是低成本切入口，市场事实层才是长期资产。',13)
# cost layers
draw_p(c,'三层投入结构',M,H-84*mm,W-2*M,'h2')
layers=[
    ('高投入 / 核心资产','事实层','Offer、G/H 锁定、Order → Trade → Settlement、Holding、Delivery、Usage 回执','一旦跑通，可服务多个 Broker、模型、区域和工具。',RED),
    ('中投入 / 执行增值','执行层','Agent Gateway、Key Fit、Slot Planner、KAI Workbench、Usage Proof','把已有权益变成任务结果；可按工作流逐个增加。',ORANGE),
    ('变量投入 / 分发','分发层','结构化标的页、时段问题页、案例页、模板、来源签名和分享','随着真实成交、交付和复购事件累积，GEO 资产复用率提高。',TEAL),
]
ly=H-99*mm
for label,layer,body,detail,col in layers:
    rect(c,M,ly-22*mm,W-2*M,18*mm,PALE,GRID,8,0.6)
    c.setFillColor(col); c.rect(M,ly-22*mm,4,18*mm,fill=1,stroke=0)
    draw_p(c,label,M+12,ly-7*mm,36*mm,'h3')
    draw_p(c,layer,M+52*mm,ly-7*mm,24*mm,'h3')
    draw_p(c,body,M+82*mm,ly-6*mm,57*mm,'small')
    draw_p(c,detail,M+143*mm,ly-6*mm,W-M-151*mm,'small')
    ly-=25*mm
# external analogues
draw_p(c,'公开市场的结构类比（不是 KAI 现状）',M,ly-2*mm,W-2*M,'h2')
case_y=ly-16*mm; gap=6*mm; cw=(W-2*M-gap)/2
rect(c,M,case_y-42*mm,cw,42*mm,DEEP,radius=9)
draw_p(c,'Vistar Media / T-Mobile',M+12,case_y-8*mm,cw-24,'white_body')
draw_p(c,'1.1M+ 数字屏 · 370 家媒体所有者 · 3,000+ 品牌伙伴 · 约 6 亿美元现金收购。',M+12,case_y-17*mm,cw-24,'white_small')
draw_p(c,'类比点：价值来自把分散供给聚合成可买、可管理、可测量的市场；数字是外部案例，不是 KAI 估值依据。',M+12,case_y-30*mm,cw-24,'white_small')
xx=M+cw+gap
rect(c,xx,case_y-42*mm,cw,42*mm,DEEP,radius=9)
draw_p(c,'AWS EC2 Spot',xx+12,case_y-8*mm,cw-24,'white_body')
draw_p(c,'最高可比按需价格低 90%；价格随供需变化，并存在中断与容量不可得。',xx+12,case_y-17*mm,cw-24,'white_small')
draw_p(c,'类比点：闲置小时只有在统一标的、动态价格和可执行调度下，才会变成可交易容量；折扣不是 KAI 预测。',xx+12,case_y-30*mm,cw-24,'white_small')
# pilot conclusion
rect(c,M,32*mm,W-2*M,25*mm,PALE,radius=9)
draw_p(c,'建议的投入顺序',M+12,53*mm,W-2*M-24,'h3')
draw_p(c,'1 个模型 × 1 个区域 × 1 个高频工作流 × 30 天；先验证 Offer → Hour Key 封装 → Holding → Usage → Repeat，再扩 Broker、区域和工具。',M+12,47*mm,W-2*M-24,'body')
draw_p(c,'外部参考：T-Mobile Newsroom（2025-01-13）；Amazon EC2 Spot Pricing（官方页面）。',M+12,36*mm,W-2*M-24,'tiny')
footer(c,13)

c.save()
print(OUT)
