import mongoose from 'mongoose';

export async function connectDB() {
    const mongoUri = process.env.MONGO_URI;

    if (!mongoUri) {
        console.error('[MongoDB] MONGO_URI не найден в переменных окружения. База данных не будет подключена.');
        return;
    }

    try {
        await mongoose.connect(mongoUri);
        console.log('[MongoDB] База данных успешно подключена.');
    } catch (error) {
        console.error('[MongoDB] Ошибка подключения к MongoDB:', error);
        process.exit(1);
    }
}
